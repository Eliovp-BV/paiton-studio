"""Explicit release is a CPU-tested lifecycle request, never direct GPU control."""
import json
import subprocess
import threading
import time
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from studio.app import create_app
from studio.queue import Worker
from studio.registry import profile
from studio.runtime import Runtime, RuntimeFailure
from studio.store import Store


def retained(runtime, selected=None):
    selected = selected or profile('gptoss-writing', 'write')
    runtime._warm = dict(package='gptoss', revision=selected['revision'], image='pinned-image',
                         container='owned-fixture', since=time.monotonic())


@pytest.fixture
def runtime(tmp_path, monkeypatch):
    instance = Runtime(Store(tmp_path), {'gptoss_image': 'pinned-image'})
    monkeypatch.setattr(instance, 'command', lambda *args, **kwargs: pytest.fail('No Docker call is allowed.'))
    return instance


def test_release_is_idempotent_and_presence_cannot_undo_it(runtime):
    retained(runtime)
    status = runtime.request_release()
    assert status['retained_model']['state'] == 'releasing'
    assert status['retained_model']['runtime_image'] == 'pinned-image'
    assert status['retained_model']['idle_remaining_seconds'] == 0
    for _ in range(2):
        runtime.touch_chat()
        runtime.configure_memory_policy(15)
        assert runtime.warm_live() and runtime.warm_expired()
        assert runtime.request_release()['retained_model']['state'] == 'releasing'
    assert not runtime.warm_for({'profile': profile('gptoss-writing', 'write')})


def test_release_without_retained_model_is_a_no_op(runtime):
    assert runtime.request_release()['retained_model'] is None
    runtime.touch_chat()
    assert not runtime.warm_live()
    assert runtime.request_release()['retained_model'] is None


def test_worker_releases_only_at_idle_boundary_and_keeps_lease_until_stopped(runtime, monkeypatch):
    retained(runtime)
    worker = Worker(runtime.store, runtime)
    worker._recovery_needed = False
    worker.poll_seconds = .001
    events = []
    lease = SimpleNamespace(close=lambda: events.append('lease-closed'))
    worker._warm_lease = lease
    def stop(container):
        assert container == 'owned-fixture'
        assert worker._warm_lease is lease
        assert runtime.memory_status()['retained_model']['state'] == 'releasing'
        events.append('stopped')
        worker.closed.set()
    monkeypatch.setattr(runtime, 'stop', stop)
    runtime.request_release()
    assert not events and worker._warm_lease is lease
    worker.loop()
    assert events == ['stopped', 'lease-closed']
    assert worker._warm_lease is None
    assert runtime.memory_status()['retained_model'] is None


def test_failed_cleanup_stays_releasing_and_retains_lease(runtime, monkeypatch):
    retained(runtime)
    worker = Worker(runtime.store, runtime)
    closed = []
    worker._warm_lease = SimpleNamespace(close=lambda: closed.append(True))
    runtime.request_release()
    def fail(container):
        raise RuntimeFailure('Synthetic stop failure')
    monkeypatch.setattr(runtime, 'stop', fail)
    with pytest.raises(RuntimeFailure):
        worker._drop_warm()
    runtime.touch_chat()
    assert not closed and worker._warm_lease is not None
    assert runtime.warm_expired()
    assert runtime.memory_status()['retained_model']['state'] == 'releasing'
    monkeypatch.setattr(runtime, 'stop', lambda container: None)
    worker._drop_warm()
    assert closed and runtime.memory_status()['retained_model'] is None


@pytest.mark.parametrize('phase', ['during_reply', 'before_reuse'])
def test_release_during_reply_finishes_work_and_survives_retention_refresh(runtime, monkeypatch, phase):
    selected = profile('gptoss-writing', 'write')
    retained(runtime, selected)
    store = runtime.store
    job = store.enqueue(store.create_project()['id'], dict(task='write', profile=selected,
                        prompt='Synthetic notes', seed=42))
    entered, finish = threading.Event(), threading.Event()
    results, failures, stops = [], [], []
    monkeypatch.setattr('studio.runtime.compatibility', lambda *args: {'compatible': True})
    monkeypatch.setattr('studio.runtime.gpu_status', lambda: {})
    monkeypatch.setattr('studio.release_adapters.prepare_harmony',
                        lambda *args: runtime.request_release() if phase == 'before_reuse' else None)
    monkeypatch.setattr(runtime, 'preflight', lambda request: 'pinned-image')
    monkeypatch.setattr(runtime, 'chat_source', lambda *args: ([], {}))
    monkeypatch.setattr(runtime, 'wait_ready', lambda *args: None)
    monkeypatch.setattr(runtime, 'http', lambda *args, **kwargs: {'count': 10})
    monkeypatch.setattr(runtime, 'start', lambda *args, **kwargs: pytest.fail('Existing model must be reused.'))
    monkeypatch.setattr(runtime, 'stop', lambda container: stops.append(container))
    def command(arguments, **kwargs):
        assert arguments[0] == 'exec'
        entered.set()
        assert finish.wait(3)
        assert not stops
        (store.root / 'jobs' / job['id'] / 'writing-result.json').write_text(json.dumps({
            'choices': [{'message': {'content': 'Completed synthetic reply.'}, 'finish_reason': 'stop'}]}))
        return subprocess.CompletedProcess(arguments, 0, '', '')
    monkeypatch.setattr(runtime, 'command', command)
    def run():
        try:
            results.append(runtime.run(job))
        except BaseException as error:
            failures.append(error)
    thread = threading.Thread(target=run)
    thread.start()
    try:
        assert entered.wait(2)
        assert runtime.request_release()['retained_model']['state'] == 'releasing'
        runtime.touch_chat()
        runtime.configure_memory_policy(15)
        assert not stops
    finally:
        finish.set()
        thread.join(3)
    assert not thread.is_alive() and not failures
    assert results[0][1].read_text() == 'Completed synthetic reply.'
    assert not stops and runtime.warm_expired()
    assert runtime.memory_status()['retained_model']['state'] == 'releasing'
    runtime.drop_warm()
    assert stops == ['owned-fixture'] and not runtime.warm_live()


def test_release_endpoint_requires_session_and_never_calls_docker(tmp_path, monkeypatch):
    app = create_app(tmp_path, config={}, worker_enabled=False)
    runtime = app.state.worker.runtime
    monkeypatch.setattr(runtime, 'command', lambda *args, **kwargs: pytest.fail('Release endpoint must not call Docker.'))
    with TestClient(app) as client:
        assert client.post('/api/model-memory/release', json={}).status_code == 401
        token = client.get('/api/session').json()['token']
        assert client.post('/api/model-memory/release', json={}).status_code == 403
        client.headers['X-Studio-Token'] = token
        retained(runtime)
        response = client.post('/api/model-memory/release', json={})
        assert response.status_code == 200
        assert response.json()['retained_model']['state'] == 'releasing'
        assert runtime.warm_live()
        assert client.get('/api/status').json()['model_memory']['retained_model']['state'] == 'releasing'
