"""Paired Comfy sockets use fake peers/upstreams and a temporary local database."""
import asyncio
from types import SimpleNamespace

import pytest
from starlette.datastructures import Headers, QueryParams

from studio import comfy_workspace
from studio.pairing import Pairing, SESSION_SECONDS
from studio.store import Store


class BrowserSocket:
    def __init__(self, token):
        self.cookies = {'studio_session': token}
        self.headers = Headers({'host': '127.0.0.1:8877', 'origin': 'http://127.0.0.1:8877'})
        self.query_params = QueryParams('clientId=synthetic-client')
        self.messages = asyncio.Queue()
        self.accepted = asyncio.Event()
        self.closed = asyncio.Event()
        self.sent = []
        self.close_codes = []
        self.receiving = False

    async def accept(self):
        self.accepted.set()

    async def receive(self):
        self.receiving = True
        try:
            return await self.messages.get()
        finally:
            self.receiving = False

    async def send_text(self, text):
        self.sent.append(text)

    async def send_bytes(self, data):
        self.sent.append(data)

    async def close(self, code):
        self.close_codes.append(code)
        self.closed.set()


class RuntimeSocket:
    def __init__(self):
        self.messages = asyncio.Queue()
        self.sent = []
        self.entered = False
        self.exited = False
        self.reading = False

    async def __aenter__(self):
        self.entered = True
        return self

    async def __aexit__(self, *args):
        self.exited = True

    def __aiter__(self):
        return self

    async def __anext__(self):
        self.reading = True
        try:
            item = await self.messages.get()
        finally:
            self.reading = False
        if isinstance(item, Exception):
            raise item
        if item is None:
            raise StopAsyncIteration
        return item

    async def send(self, value):
        self.sent.append(value)


@pytest.fixture
def grant(tmp_path):
    now = [1000.0]
    pairing = Pairing(Store(tmp_path), clock=lambda: now[0])
    token = pairing.pair(pairing.configure(True)['pairing_token'], 'Synthetic browser', '192.0.2.9')
    identity = pairing.snapshot()['devices'][0]['id']
    workspace = comfy_workspace.ComfyWorkspace.__new__(comfy_workspace.ComfyWorkspace)
    workspace.authorities = {'127.0.0.1:8877'}
    workspace.token = 'unrelated-local-owner-session-token'
    workspace.browser_authorized = lambda connection: pairing.authorized(connection.cookies.get('studio_session'))
    workspace.session = lambda identity: {'port': 12345, 'proxy_token': 'synthetic-editor-secret'}
    return SimpleNamespace(pairing=pairing, now=now, token=token, identity=identity, workspace=workspace)


async def until(condition):
    async def check():
        while not condition():
            await asyncio.sleep(0)
    await asyncio.wait_for(check(), timeout=1)


def sockets(grant, monkeypatch):
    browser, upstream = BrowserSocket(grant.token), RuntimeSocket()
    calls = []

    def connect(url, **options):
        calls.append((url, options))
        return upstream

    monkeypatch.setattr(comfy_workspace, 'connect', connect)
    return browser, upstream, calls


def controlled_poll(monkeypatch):
    real_sleep = asyncio.sleep
    entered, tick = asyncio.Event(), asyncio.Event()
    intervals = []

    async def sleep(delay):
        if delay == .5:
            intervals.append(delay)
            entered.set()
            await tick.wait()
            tick.clear()
        else:
            await real_sleep(delay)

    monkeypatch.setattr(comfy_workspace.asyncio, 'sleep', sleep)
    return entered, tick, intervals


async def assert_clean(task, baseline, browser, upstream, close_code):
    await asyncio.wait_for(task, timeout=1)
    assert browser.close_codes == [close_code]
    assert upstream.exited
    assert not browser.receiving and not upstream.reading
    assert asyncio.all_tasks() <= baseline, 'Forwarding or polling task survived socket cleanup'


def test_authorized_pair_forwards_text_and_bytes_and_disconnect_cleans_tasks(grant, monkeypatch):
    async def scenario():
        baseline = asyncio.all_tasks()
        browser, upstream, calls = sockets(grant, monkeypatch)
        entered, tick, intervals = controlled_poll(monkeypatch)
        task = asyncio.create_task(grant.workspace.websocket(browser, 'session', 'ws'))
        await asyncio.wait_for(browser.accepted.wait(), timeout=1)
        await asyncio.wait_for(entered.wait(), timeout=1)
        await browser.messages.put({'type': 'websocket.receive', 'text': 'browser text'})
        await browser.messages.put({'type': 'websocket.receive', 'bytes': b'browser bytes'})
        await upstream.messages.put('runtime text')
        await upstream.messages.put(b'runtime bytes')
        await until(lambda: len(browser.sent) == 2 and len(upstream.sent) == 2)
        assert upstream.sent == ['browser text', b'browser bytes']
        assert browser.sent == ['runtime text', b'runtime bytes']
        assert calls[0][0] == 'ws://127.0.0.1:12345/ws?clientId=synthetic-client'
        assert calls[0][1]['proxy'] is None
        assert calls[0][1]['additional_headers'] == {'x-paiton-editor-token': 'synthetic-editor-secret'}
        await browser.messages.put({'type': 'websocket.disconnect'})
        await assert_clean(task, baseline, browser, upstream, 1000)
        assert intervals == [.5]
    asyncio.run(scenario())


@pytest.mark.parametrize('direction', ['browser', 'runtime'])
@pytest.mark.parametrize('payload', ['post-revocation text', b'post-revocation bytes'])
def test_revocation_blocks_each_forwarding_direction_before_next_poll(grant, monkeypatch, direction, payload):
    async def scenario():
        baseline = asyncio.all_tasks()
        browser, upstream, calls = sockets(grant, monkeypatch)
        entered, tick, intervals = controlled_poll(monkeypatch)
        task = asyncio.create_task(grant.workspace.websocket(browser, 'session', 'ws'))
        await asyncio.wait_for(browser.accepted.wait(), timeout=1)
        await asyncio.wait_for(entered.wait(), timeout=1)
        grant.pairing.revoke(grant.identity)
        if direction == 'browser':
            await browser.messages.put({'type': 'websocket.receive',
                                        'bytes' if isinstance(payload, bytes) else 'text': payload})
        else:
            await upstream.messages.put(payload)
        # The monitor remains asleep: only the per-message check can close here.
        await assert_clean(task, baseline, browser, upstream, 1008)
        assert not upstream.sent and not browser.sent
        assert intervals == [.5] and not tick.is_set()
    asyncio.run(scenario())


@pytest.mark.parametrize('revocation', ['device', 'network', 'expiry'])
def test_idle_pair_closes_on_next_half_second_authorization_poll(grant, monkeypatch, revocation):
    async def scenario():
        baseline = asyncio.all_tasks()
        browser, upstream, calls = sockets(grant, monkeypatch)
        entered, tick, intervals = controlled_poll(monkeypatch)
        task = asyncio.create_task(grant.workspace.websocket(browser, 'session', 'ws'))
        await asyncio.wait_for(browser.accepted.wait(), timeout=1)
        await asyncio.wait_for(entered.wait(), timeout=1)
        if revocation == 'device':
            grant.pairing.revoke(grant.identity)
        elif revocation == 'network':
            grant.pairing.configure(False)
        else:
            grant.now[0] += SESSION_SECONDS
        assert not browser.closed.is_set()
        assert intervals == [.5], 'Idle authorization must be checked every half second'
        tick.set()
        await assert_clean(task, baseline, browser, upstream, 1008)
        assert not browser.sent and not upstream.sent
        assert browser.messages.empty() and upstream.messages.empty()
    asyncio.run(scenario())


def test_revoked_grant_never_connects_or_accepts(grant, monkeypatch):
    async def scenario():
        baseline = asyncio.all_tasks()
        browser, upstream, calls = sockets(grant, monkeypatch)
        grant.pairing.revoke(grant.identity)
        await grant.workspace.websocket(browser, 'session', 'ws')
        assert browser.close_codes == [1008] and not browser.accepted.is_set()
        assert not calls and not upstream.entered
        assert asyncio.all_tasks() == baseline
    asyncio.run(scenario())


@pytest.mark.parametrize('ending', ['cancel', 'upstream_error', 'upstream_close'])
def test_cancellation_and_upstream_termination_clean_all_three_tasks(grant, monkeypatch, ending):
    async def scenario():
        baseline = asyncio.all_tasks()
        browser, upstream, calls = sockets(grant, monkeypatch)
        entered, tick, intervals = controlled_poll(monkeypatch)
        task = asyncio.create_task(grant.workspace.websocket(browser, 'session', 'ws'))
        await asyncio.wait_for(browser.accepted.wait(), timeout=1)
        await asyncio.wait_for(entered.wait(), timeout=1)
        if ending == 'cancel':
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await asyncio.wait_for(task, timeout=1)
            assert browser.close_codes == [1000]
            assert upstream.exited and not browser.receiving and not upstream.reading
            assert asyncio.all_tasks() <= baseline
        else:
            await upstream.messages.put(OSError('Synthetic upstream failure') if ending == 'upstream_error' else None)
            await assert_clean(task, baseline, browser, upstream, 1000)
    asyncio.run(scenario())
