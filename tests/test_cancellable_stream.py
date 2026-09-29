"""Real loopback transport tests; no Docker, model runtime, or GPU access."""
from contextlib import contextmanager
import errno
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import socket
import subprocess
import sys
import threading
import time
from types import SimpleNamespace

import pytest

from scripts import cancellable_stream as relay


NONCE = 'a' * 32
OTHER = 'b' * 32


@contextmanager
def server(mode='prefill', content=None, *, openai=False):
    state = SimpleNamespace(entered=threading.Event(), disconnect=threading.Event(),
                            release=threading.Event(), sent=threading.Event(), bodies=[])

    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, *args):
            pass

        def do_POST(self):
            state.bodies.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
            if mode == 'headers':
                state.entered.set()
            else:
                self.send_response(429 if mode == 'error' else 200)
                self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Connection', 'close')
                self.end_headers()
                if mode == 'error':
                    self.wfile.write(b'Fixture unavailable')
                    return
                if mode == 'complete':
                    event = ({'choices': [{'index': 0, 'delta': {'content': 'done'}, 'finish_reason': 'stop'}],
                              'usage': {'prompt_tokens': 10, 'completion_tokens': 1, 'total_tokens': 11}}
                             if openai else {'text': 'done'})
                    self.wfile.write(('data: ' + json.dumps(event) + '\n\ndata: [DONE]\n\n').encode())
                    return
                if mode == 'tool':
                    event = {'choices': [{'index': 0, 'delta': {
                        'reasoning_content': 'Private reasoning fixture',
                        'tool_calls': [{'index': 0, 'id': 'call_fixture', 'type': 'function',
                                        'function': {'name': 'save_code_draft',
                                                     'arguments': '{"private":"incomplete'}}],
                    }, 'finish_reason': None}]}
                    self.wfile.write(('data: ' + json.dumps(event) + '\n\n').encode())
                    self.wfile.flush()
                    state.sent.set()
                if mode in ('partial', 'burst', 'truncated'):
                    values = content or ['A brief reply']
                    for value in values:
                        event = ({'choices': [{'index': 0, 'delta': {'content': value}, 'finish_reason': None}]}
                                 if openai else {'text': value})
                        self.wfile.write(('data: ' + json.dumps(event) + '\n\n').encode())
                    self.wfile.flush()
                    state.sent.set()
                    if mode == 'truncated':
                        return
                state.entered.set()
            # No response timeout is needed to observe client cancellation.
            # recv returns EOF only when the client's actual transport closes.
            self.connection.settimeout(2)
            try:
                if self.connection.recv(1) == b'':
                    state.disconnect.set()
            except (ConnectionError, OSError):
                state.disconnect.set()
            finally:
                state.release.wait(2)

    instance = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    instance.daemon_threads = True
    thread = threading.Thread(target=instance.serve_forever, kwargs={'poll_interval': .01}, daemon=True)
    thread.start()
    state.port = instance.server_port
    try:
        yield state
    finally:
        state.release.set()
        instance.shutdown()
        instance.server_close()
        thread.join(1)


def consume(tmp_path, server, *, nonce=NONCE, internal=False, after_line=None, timeout=3):
    result = SimpleNamespace(text='', error=None, done=threading.Event(), lines=[], callbacks=[])

    def partial():
        result.callbacks.append(threading.get_ident())
        return result.text

    stream = relay.CancellableStream(tmp_path, nonce=nonce, port=server.port,
                                    body={'messages': [], 'stream': True}, partial=partial,
                                    internal=internal, timeout=timeout, poll_interval=.005)
    result.stream = stream

    def run():
        result.consumer_thread = threading.get_ident()
        try:
            with stream:
                for line in stream:
                    result.lines.append(line)
                    if line.startswith(b'data: ') and line.strip() != b'data: [DONE]':
                        result.text += json.loads(line[6:]).get('text', '')
                        if after_line:
                            after_line(result)
        except Exception as error:
            result.error = error
        finally:
            result.done.set()

    result.thread = threading.Thread(target=run, daemon=True)
    result.thread.start()
    return result


def finish(result):
    assert result.done.wait(2), 'Cancellation must wake a blocked HTTP call promptly.'
    result.thread.join(1)
    assert not result.thread.is_alive()
    assert not result.stream._watchdog.is_alive(), 'Every outcome must stop its watchdog.'


@pytest.mark.parametrize('mode', ['headers', 'prefill', 'partial'])
def test_cancel_interrupts_headers_prefill_and_stalled_read(tmp_path, mode):
    with server(mode) as host:
        result = consume(tmp_path, host)
        assert host.entered.wait(1)
        if mode == 'partial':
            deadline = time.monotonic() + 1
            while not result.text and time.monotonic() < deadline:
                result.done.wait(.005)
            assert result.text == 'A brief reply'
        assert relay.read_ack(tmp_path, NONCE) is None
        relay.request_cancel(tmp_path, NONCE)
        finish(result)
        assert isinstance(result.error, relay.StreamCancelled)
        assert host.disconnect.wait(1), 'The server must observe the real HTTP disconnect.'
        ack = relay.read_ack(tmp_path, NONCE)
        assert ack['state'] == 'cancelled' and ack['connection_closed']
        assert ack['partial'] == result.text
        assert result.callbacks == [result.consumer_thread]
        assert host.bodies == [{'messages': [], 'stream': True}]


def test_final_burst_flush_has_no_progress_throttle(tmp_path):
    reached = threading.Event()
    values = ['one ', 'two ', 'three']

    def after_line(result):
        if result.text == ''.join(values):
            # Deliberately cancel before the caller could publish a 400 ms
            # throttled progress update. The final acknowledgement keeps it.
            relay.request_cancel(tmp_path, NONCE)
            reached.set()

    with server('burst', values) as host:
        result = consume(tmp_path, host, after_line=after_line)
        assert reached.wait(1)
        finish(result)
        assert isinstance(result.error, relay.StreamCancelled)
        assert relay.read_ack(tmp_path, NONCE)['partial'] == ''.join(values)
        assert host.disconnect.wait(1)


@pytest.mark.parametrize('marker', [b'not json', b'{"nonce":12}', b'{"nonce":"stale"}',
                                    json.dumps({'nonce': OTHER}).encode(), b'x' * 5000])
def test_invalid_or_stale_marker_cannot_cancel_another_invocation(tmp_path, marker):
    (tmp_path / relay.CANCEL_FILE).write_bytes(marker)
    with server('prefill') as host:
        result = consume(tmp_path, host)
        assert host.entered.wait(1)
        assert not result.done.wait(.04)
        assert relay.read_ack(tmp_path, NONCE) is None
        relay.request_cancel(tmp_path, NONCE)
        finish(result)
        assert isinstance(result.error, relay.StreamCancelled)
        assert relay.read_ack(tmp_path, OTHER) is None


def test_cancellation_before_connect_opens_no_request(tmp_path):
    relay.request_cancel(tmp_path, NONCE)
    with server('complete') as host:
        result = consume(tmp_path, host)
        finish(result)
        assert isinstance(result.error, relay.StreamCancelled)
        assert host.bodies == []
        assert relay.read_ack(tmp_path, NONCE)['state'] == 'cancelled'


def test_cancellation_interrupts_pending_connect(tmp_path, monkeypatch):
    entered = threading.Event()
    closed = threading.Event()

    class PendingSocket:
        def setblocking(self, value):
            pass

        def connect_ex(self, address):
            assert address == ('127.0.0.1', 12345)
            entered.set()
            return errno.EINPROGRESS

        def shutdown(self, how):
            assert how == socket.SHUT_RDWR

        def close(self):
            closed.set()

    monkeypatch.setattr(relay.socket, 'socket', lambda *args, **kwargs: PendingSocket())

    def pending(*args):
        closed.wait(.005)
        return [], [], []

    monkeypatch.setattr(relay.select, 'select', pending)
    result = consume(tmp_path, SimpleNamespace(port=12345))
    assert entered.wait(1)
    relay.request_cancel(tmp_path, NONCE)
    finish(result)
    assert isinstance(result.error, relay.StreamCancelled)
    assert closed.is_set()
    assert relay.read_ack(tmp_path, NONCE)['state'] == 'cancelled'


@pytest.mark.parametrize('mode', ['complete', 'error', 'truncated'])
def test_success_http_error_and_early_eof_close_watchdog(tmp_path, mode):
    with server(mode) as host:
        result = consume(tmp_path, host)
        finish(result)
        ack = relay.read_ack(tmp_path, NONCE)
        assert ack['connection_closed']
        if mode == 'error':
            assert isinstance(result.error, relay.StreamHTTPError)
            assert result.error.status == 429 and result.error.body == 'Fixture unavailable'
            assert ack['state'] == 'error'
        else:
            assert result.error is None
            assert ack['state'] == 'closed'
            assert result.text == ('done' if mode == 'complete' else 'A brief reply')
        # HTTP transport EOF is deliberately not an assertion of a complete
        # model answer: StreamResponse remains responsible for that contract.


def test_internal_summary_never_leaks_into_cancel_ack(tmp_path):
    received = threading.Event()
    with server('partial', ['Private summary fixture']) as host:
        result = consume(tmp_path, host, internal=True, after_line=lambda value: received.set())
        assert received.wait(1)
        relay.request_cancel(tmp_path, NONCE)
        finish(result)
        ack = relay.read_ack(tmp_path, NONCE)
        assert ack['partial'] is None and ack['state'] == 'cancelled'
        assert 'Private summary fixture' not in (tmp_path / relay.ACK_FILE).read_text()
        assert result.callbacks == []


def test_consumer_error_closes_transport_and_does_not_masquerade_as_cancel(tmp_path):
    def malformed(value):
        raise ValueError('Fixture rejected malformed model delta')

    with server('partial') as host:
        result = consume(tmp_path, host, after_line=malformed)
        finish(result)
        assert isinstance(result.error, ValueError)
        assert host.disconnect.wait(1)
        ack = relay.read_ack(tmp_path, NONCE)
        assert ack['state'] == 'error' and ack['partial'] == 'A brief reply'


@pytest.mark.parametrize('mode', ['headers', 'prefill'])
def test_socket_timeout_also_stops_watchdog_and_closes_transport(tmp_path, mode):
    with server(mode) as host:
        result = consume(tmp_path, host, timeout=.1)
        finish(result)
        assert isinstance(result.error, TimeoutError)
        assert relay.read_ack(tmp_path, NONCE)['state'] == 'error'
        assert host.disconnect.wait(1)


def test_ack_only_follows_response_and_socket_cleanup(tmp_path, monkeypatch):
    written = []
    original = relay._atomic_json

    def record(path, value):
        if path.name == relay.ACK_FILE:
            assert result.stream._response.isclosed()
            assert result.stream._socket.fileno() == -1
            assert not result.stream._watchdog.is_alive()
            written.append(value)
        return original(path, value)

    monkeypatch.setattr(relay, '_atomic_json', record)
    with server('prefill') as host:
        result = consume(tmp_path, host)
        assert host.entered.wait(1)
        relay.request_cancel(tmp_path, NONCE)
        finish(result)
        assert len(written) == 1 and written[0]['state'] == 'cancelled'


@pytest.mark.parametrize('nonce', ['', 'x' * 32, 'a' * 31, '../escape', None, 12])
def test_invalid_nonce_rejected_before_any_transport(tmp_path, nonce):
    with pytest.raises(ValueError, match='nonce'):
        relay.CancellableStream(tmp_path, nonce=nonce, port=12345, body={})
    with pytest.raises(ValueError, match='nonce'):
        relay.request_cancel(tmp_path, nonce)
    assert list(tmp_path.iterdir()) == []


def test_ack_parser_rejects_stale_incomplete_or_unbounded_records(tmp_path):
    path = tmp_path / relay.ACK_FILE
    valid = dict(nonce=NONCE, state='cancelled', connection_closed=True, partial='kept')
    for value in ({**valid, 'nonce': OTHER}, {**valid, 'connection_closed': False},
                  {**valid, 'state': 'running'}, {**valid, 'partial': 1},
                  {**valid, 'partial': 'x' * (relay.MAX_PARTIAL + 1)}):
        path.write_text(json.dumps(value))
        assert relay.read_ack(tmp_path, NONCE) is None
    path.write_text(json.dumps(valid))
    assert relay.read_ack(tmp_path, NONCE) == valid


@contextmanager
def chat_process(directory, port, *, internal=False, instrument=False, tools=False):
    scripts = Path(__file__).resolve().parents[1] / 'scripts'
    request = dict(port=port, invocation_nonce=NONCE, internal=internal,
                   body={'model': 'CPU fixture', 'messages': []}, timeout=3)
    if tools:
        request['body']['tools'] = [{'type': 'function', 'function': {'name': 'save_code_draft'}}]
    (directory / 'writing-request.json').write_text(json.dumps(request))
    if instrument:
        # Synchronize on the parser consuming the unthrottled final delta,
        # without changing production code or relying on wall-clock sleeps.
        wrapper = '''
import runpy,sys
from pathlib import Path
scripts, directory = sys.argv[1:]
sys.path.insert(0, scripts)
from stream_protocol import StreamResponse
original=StreamResponse.feed
def feed(self,event):
    original(self,event)
    if self.content=='first final' or self.calls:
        (Path(directory)/'fixture-parsed').write_text('ready')
StreamResponse.feed=feed
sys.argv=[str(Path(scripts)/'chat_stream.py'),directory]
runpy.run_path(sys.argv[0],run_name='__main__')
'''
        command = [sys.executable, '-c', wrapper, str(scripts), str(directory)]
    else:
        command = [sys.executable, str(scripts / 'chat_stream.py'), str(directory)]
    child = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        yield child
    finally:
        if child.poll() is None:
            child.kill()
        child.communicate(timeout=2)


def test_actual_chat_relay_keeps_success_and_usage_contract(tmp_path):
    with server('complete', openai=True) as host, chat_process(tmp_path, host.port) as child:
        output, errors = child.communicate(timeout=3)
        assert child.returncode == 0, errors
        result = json.loads((tmp_path / 'writing-result.json').read_text())
        assert result['choices'][0]['message']['content'] == 'done'
        assert result['invocation_nonce'] == NONCE
        assert result['usage']['completion_tokens'] == 1
        assert result['timing']['first_output_at'] is not None
        assert 'STUDIO:' in output and not errors
        assert relay.read_ack(tmp_path, NONCE)['state'] == 'closed'
        assert host.bodies[0]['stream_options'] == {'include_usage': True}


@pytest.mark.parametrize('internal', [False, True])
def test_actual_chat_relay_cancel_flush_and_internal_suppression(tmp_path, internal):
    with server('burst', ['first ', 'final'], openai=True) as host:
        with chat_process(tmp_path, host.port, internal=internal, instrument=True) as child:
            deadline = time.monotonic() + 2
            while not (tmp_path / 'fixture-parsed').exists() and time.monotonic() < deadline:
                assert child.poll() is None
                host.release.wait(.005)
            assert (tmp_path / 'fixture-parsed').exists()
            relay.request_cancel(tmp_path, NONCE)
            output, errors = child.communicate(timeout=2)
            assert child.returncode == 130, errors
            assert not (tmp_path / 'writing-result.json').exists()
            assert host.disconnect.wait(1)
            ack = relay.read_ack(tmp_path, NONCE)
            assert ack['state'] == 'cancelled'
            assert ack['partial'] == (None if internal else 'first final')
            if internal:
                assert output == '' and 'first final' not in (tmp_path / relay.ACK_FILE).read_text()
            else:
                events = [json.loads(line[7:]) for line in output.splitlines() if line.startswith('STUDIO:')]
                assert events[0]['progress']['text'] == 'first '
                assert events[-1]['state'] == 'cancelling'
                assert events[-1]['progress']['text'] == 'first final'
            assert not errors


def test_actual_chat_relay_rejects_truncation_without_success_ack(tmp_path):
    with server('truncated', openai=True) as host, chat_process(tmp_path, host.port) as child:
        output, errors = child.communicate(timeout=3)
        assert child.returncode == 0, errors
        result = json.loads((tmp_path / 'writing-result.json').read_text())
        assert 'incomplete or malformed' in result['error']['message']
        assert result['invocation_nonce'] == NONCE
        assert relay.read_ack(tmp_path, NONCE)['state'] == 'error'
        assert 'A brief reply' in output


def test_actual_chat_relay_cancel_before_headers_discards_old_result(tmp_path):
    (tmp_path / 'writing-result.json').write_text('{"old":"must never be reused"}')
    with server('headers', openai=True) as host, chat_process(tmp_path, host.port) as child:
        assert host.entered.wait(2)
        relay.request_cancel(tmp_path, NONCE)
        output, errors = child.communicate(timeout=2)
        assert child.returncode == 130, errors
        assert not (tmp_path / 'writing-result.json').exists()
        assert relay.read_ack(tmp_path, NONCE)['partial'] == ''
        assert json.loads(output.splitlines()[-1][7:])['state'] == 'cancelling'
        assert host.disconnect.wait(1)


def test_actual_chat_relay_never_exposes_incomplete_tool_arguments(tmp_path):
    with server('tool', openai=True) as host:
        with chat_process(tmp_path, host.port, tools=True, instrument=True) as child:
            deadline = time.monotonic() + 2
            while not (tmp_path / 'fixture-parsed').exists() and time.monotonic() < deadline:
                assert child.poll() is None
                host.release.wait(.005)
            assert (tmp_path / 'fixture-parsed').exists()
            relay.request_cancel(tmp_path, NONCE)
            output, errors = child.communicate(timeout=2)
            assert child.returncode == 130, errors
            assert not (tmp_path / 'writing-result.json').exists()
            assert relay.read_ack(tmp_path, NONCE)['partial'] == ''
            combined = output + (tmp_path / relay.ACK_FILE).read_text()
            assert 'Private reasoning fixture' not in combined
            assert 'incomplete' not in combined and 'save_code_draft' not in combined
            assert host.disconnect.wait(1)
