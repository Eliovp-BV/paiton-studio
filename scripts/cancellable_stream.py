"""Cancellable loopback HTTP relay for an owned model container.

An acknowledgement proves this client's transport closed, not that a model
engine removed its request. Runtime policy must establish that separately.
Only the consuming thread reads/closes HTTPResponse; the watchdog shuts down
the retained socket so cancellation can interrupt headers and stalled bodies.
"""
import errno
import http.client
import json
import os
from pathlib import Path
import re
import select
import socket
import tempfile
import threading
import time


CANCEL_FILE = 'stream-cancel.json'
ACK_FILE = 'stream-ack.json'
MAX_PARTIAL = 200_000
MAX_LINE_BYTES = 1_048_576


class StreamCancelled(Exception):
    """The invocation was cancelled and its HTTP transport was closed."""


class StreamHTTPError(RuntimeError):
    def __init__(self, status, body):
        self.status = status
        self.body = body
        super().__init__(f'The local server returned HTTP {status}: {body}')


def _nonce(value):
    if not isinstance(value, str) or not re.fullmatch(r'[a-f0-9]{32}', value):
        raise ValueError('Use a fresh 32-character hexadecimal invocation nonce.')
    return value


def _atomic_json(path, value):
    descriptor, temporary = tempfile.mkstemp(prefix='.' + path.name + '-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
            json.dump(value, stream, ensure_ascii=False)
            stream.flush()
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def _read_json(path, maximum):
    try:
        with path.open('rb') as stream:
            raw = stream.read(maximum + 1)
        if len(raw) > maximum:
            return None
        value = json.loads(raw)
        return value if isinstance(value, dict) else None
    except (OSError, ValueError):
        return None


def request_cancel(directory, nonce):
    """Atomically request cancellation of one exact relay invocation."""
    _atomic_json(Path(directory) / CANCEL_FILE, {'nonce': _nonce(nonce)})


def read_ack(directory, nonce):
    """Return only a complete acknowledgement for this exact invocation."""
    nonce = _nonce(nonce)
    value = _read_json(Path(directory) / ACK_FILE, MAX_LINE_BYTES)
    if (not value or value.get('nonce') != nonce or value.get('connection_closed') is not True
            or value.get('state') not in ('cancelled', 'closed', 'error')):
        return None
    partial = value.get('partial')
    if partial is not None and (not isinstance(partial, str) or len(partial) > MAX_PARTIAL):
        return None
    return value


class _Connection(http.client.HTTPConnection):
    def __init__(self, owner):
        super().__init__('127.0.0.1', owner.port, timeout=owner.timeout)
        self.owner = owner

    def connect(self):
        # Publish the socket before connecting. A nonblocking loop also makes
        # connection cancellation bounded on platforms where close alone does
        # not wake a different thread's blocking connect call.
        transport = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock = transport
        self.owner._attach(transport)
        transport.setblocking(False)
        result = transport.connect_ex(('127.0.0.1', self.owner.port))
        pending = {errno.EINPROGRESS, errno.EWOULDBLOCK, errno.EALREADY, errno.EINTR}
        deadline = time.monotonic() + self.timeout
        while result not in (0, errno.EISCONN):
            self.owner._check_cancel()
            if result not in pending:
                raise OSError(result, os.strerror(result))
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError('The local server connection timed out.')
            _, writable, failed = select.select([], [transport], [transport], min(.05, remaining))
            self.owner._check_cancel()
            if writable or failed:
                result = transport.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR)
        self.owner._check_cancel()
        transport.settimeout(self.timeout)


class CancellableStream:
    """Context-managed iterator of HTTP response lines from container loopback.

    ``partial`` returns the latest parsed visible reply, on the consuming
    thread. It is sampled during final cleanup, even when no throttled progress
    update was emitted. ``internal=True`` excludes private summary text.
    """
    def __init__(self, directory, *, nonce, port, body, partial=None, internal=False,
                 path='/v1/chat/completions', timeout=600, poll_interval=.05):
        self.directory = Path(directory)
        if not self.directory.is_dir():
            raise ValueError('The relay call directory must already exist.')
        self.nonce = _nonce(nonce)
        if type(port) is not int or not 1 <= port <= 65535:
            raise ValueError('Use a valid local model port.')
        if not isinstance(path, str) or not path.startswith('/') or path.startswith('//'):
            raise ValueError('Use a local HTTP request path.')
        if not 0 < timeout <= 3600 or not .001 <= poll_interval <= 1:
            raise ValueError('Use bounded connection and cancellation timeouts.')
        self.port = port
        self.body = json.dumps(body).encode()
        self.path = path
        self.timeout = timeout
        self.poll_interval = poll_interval
        self.partial = partial or (lambda: '')
        self.internal = internal
        self._cancelled = threading.Event()
        self._done = threading.Event()
        self._lock = threading.Lock()
        self._socket = None
        self._connection = None
        self._response = None
        self._watchdog = None
        self._finished = False
        self._entered = False

    def _requested(self):
        value = _read_json(self.directory / CANCEL_FILE, 4096)
        return bool(value and value.get('nonce') == self.nonce)

    def _shutdown(self):
        # Never acquire HTTPResponse's buffered-reader lock in this thread.
        # shutdown wakes its current read; the consuming thread closes it.
        with self._lock:
            transport = self._socket
            if transport is not None:
                try:
                    transport.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                transport.close()

    def _attach(self, transport):
        with self._lock:
            self._socket = transport
        self._check_cancel()

    def _check_cancel(self):
        # The watchdog performs filesystem polling. Per-token reads only
        # inspect its event, so fast streams do not open a marker per delta.
        if self._cancelled.is_set():
            self._shutdown()
            raise StreamCancelled('The local reply was stopped.')

    def _watch(self):
        while not self._done.is_set():
            if self._requested():
                self._cancelled.set()
                self._shutdown()
                return
            self._done.wait(self.poll_interval)

    def __enter__(self):
        if self._entered:
            raise RuntimeError('A relay invocation can only be entered once.')
        self._entered = True
        self._watchdog = threading.Thread(target=self._watch, name='studio-stream-cancel', daemon=True)
        self._watchdog.start()
        try:
            if self._requested():
                self._cancelled.set()
            self._check_cancel()
            self._connection = _Connection(self)
            self._connection.request('POST', self.path, self.body, {'Content-Type': 'application/json'})
            self._response = self._connection.getresponse()
            self._check_cancel()
            if not 200 <= self._response.status < 300:
                body = self._response.read(16000).decode(errors='replace')
                raise StreamHTTPError(self._response.status, body)
            return self
        except BaseException as error:
            self._finish(error)
            if self._cancelled.is_set() and not isinstance(error, StreamCancelled):
                raise StreamCancelled('The local reply was stopped.') from error
            raise

    def __iter__(self):
        return self

    def __next__(self):
        if self._response is None or self._finished:
            raise RuntimeError('Read the relay inside its context manager.')
        try:
            self._check_cancel()
            line = self._response.readline(MAX_LINE_BYTES + 1)
            self._check_cancel()
        except (OSError, ValueError, http.client.HTTPException) as error:
            if self._cancelled.is_set():
                raise StreamCancelled('The local reply was stopped.') from error
            raise
        if len(line) > MAX_LINE_BYTES:
            raise ValueError('The local reply event exceeded the supported size.')
        if not line:
            raise StopIteration
        return line

    def _finish(self, error=None):
        if self._finished:
            return
        self._finished = True
        if self._requested():
            self._cancelled.set()
        self._done.set()
        self._shutdown()
        if self._watchdog is not None:
            self._watchdog.join()
        try:
            if self._response is not None:
                self._response.close()
        finally:
            if self._connection is not None:
                self._connection.close()
        partial = None
        if not self.internal:
            try:
                value = self.partial()
                if isinstance(value, str) and len(value) <= MAX_PARTIAL:
                    partial = value
            except Exception:
                # Losing the final text callback must not hide transport
                # closure or replace an earlier persisted partial with "".
                pass
        state = 'cancelled' if self._cancelled.is_set() else 'error' if error else 'closed'
        _atomic_json(self.directory / ACK_FILE, {
            'nonce': self.nonce, 'state': state, 'connection_closed': True,
            'partial': partial, 'closed_at': time.time(),
        })

    def __exit__(self, kind, error, traceback):
        self._finish(error)
        if self._cancelled.is_set() and not isinstance(error, StreamCancelled):
            raise StreamCancelled('The local reply was stopped.') from error
        return False
