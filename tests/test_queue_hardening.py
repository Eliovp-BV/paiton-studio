"""Thread/transaction tests with private files and CPU fake runtimes only."""
import os
import threading
import time

import pytest

from studio import queue
from studio.resources import Lease
from studio.runtime import RuntimeFailure
from studio.store import Store


def wait_until(predicate, timeout=3):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(.01)
    raise AssertionError('Condition did not become true before the test deadline')


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    store = Store(tmp_path / 'data')
    project = store.create_project()['id']
    gpu_lock = tmp_path / 'gpu.lock'
    monkeypatch.setattr(queue, 'gpu_lease', lambda: Lease(gpu_lock))
    monkeypatch.setattr(queue, 'gpu_status', lambda: {'available': True, 'supported': True})
    return store, project, gpu_lock


class FakeRuntime:
    def __init__(self, store):
        self.store = store
        self.runs = []
        self.stops = []
        self.preflights = 0

    def preflight(self, request):
        self.preflights += 1

    def stop(self, container):
        self.stops.append(container)

    def run(self, job):
        self.runs.append(job['id'])
        path = self.store.root / (job['id'] + '.md')
        path.write_text('CPU fixture, never inference output')
        return 'text', path, {'fixture': True}


def worker_for(store, runtime):
    worker = queue.Worker(store, runtime)
    worker.poll_seconds = .01
    worker.recovery_retry_seconds = .02
    worker.workflow_retry_seconds = .04
    worker.admission_retry_seconds = .02
    return worker


def test_failed_startup_recovery_preserves_queue_and_retries_without_event_flood(workspace):
    store, project, _ = workspace
    active = store.enqueue(project, {'task': 'write'})
    store.status(active['id'], 'loading', 'Loading', container='own-old-container')
    pending = store.enqueue(project, {'task': 'write'})
    runtime = FakeRuntime(store)
    available = threading.Event()
    attempts = []
    def cleanup():
        attempts.append(1)
        if not available.is_set():
            raise RuntimeFailure('Docker is unavailable')
    runtime.cleanup_owned = cleanup
    worker = worker_for(store, runtime)
    worker.start()
    try:
        wait_until(lambda: len(attempts) >= 3)
        assert store.job(active['id'])['state'] == 'loading'
        assert store.job(pending['id'])['state'] == 'queued'
        assert not runtime.runs and not runtime.preflights
        events = store.rows('SELECT * FROM job_events WHERE job=?', (pending['id'],))
        assert len(events) == 1 and events[0]['message'] == queue.RECOVERY_MESSAGE
        assert worker.diagnostics()['state'] == 'recovery_blocked'
        available.set()
        wait_until(lambda: store.job(pending['id'])['state'] == 'completed')
        assert store.job(active['id'])['state'] == 'failed'
        assert runtime.stops == ['own-old-container']
    finally:
        available.set()
        worker.close()


def test_false_recovery_result_does_not_mean_success(workspace):
    store, project, _ = workspace
    pending = store.enqueue(project, {'task': 'write'})
    runtime = FakeRuntime(store)
    runtime.cleanup_owned = lambda: False
    worker = worker_for(store, runtime)
    worker.start()
    try:
        assert worker.diagnostics()['recovery_pending']
        time.sleep(.08)
        assert not runtime.runs and store.job(pending['id'])['state'] == 'queued'
    finally:
        worker.close()


def test_unexpected_workflow_exception_does_not_kill_gpu_worker(workspace):
    store, project, _ = workspace
    pending = store.enqueue(project, {'task': 'write'})
    runtime = FakeRuntime(store)
    attempts = []
    class Workflow:
        def tick(self):
            attempts.append(1)
            raise AttributeError('Unexpected coordinator error')
    worker = worker_for(store, runtime)
    worker.workflows = Workflow()
    worker.start()
    try:
        wait_until(lambda: store.job(pending['id'])['state'] == 'completed')
        wait_until(lambda: len(attempts) >= 2)
        assert worker.thread.is_alive()
        assert worker.diagnostics()['workflow_error'] == 'AttributeError'
        assert runtime.runs == [pending['id']]
    finally:
        worker.close()


def test_shutdown_retains_controller_until_runtime_and_stop_operation_finish(workspace):
    store, project, gpu_lock = workspace
    pending = store.enqueue(project, {'task': 'write'})
    entered = threading.Event()
    run_release = threading.Event()
    stop_entered = threading.Event()
    stop_release = threading.Event()
    runtime = FakeRuntime(store)
    original_run = runtime.run
    def run(job):
        store.status(job['id'], 'loading', 'Loading', container='exact-owned-container')
        entered.set()
        assert run_release.wait(3)
        return original_run(job)
    def stop(container):
        assert container == 'exact-owned-container'
        stop_entered.set()
        assert stop_release.wait(3)
    runtime.run, runtime.stop = run, stop
    worker = worker_for(store, runtime)
    controller_probe = Lease(store.root / 'controller.lock')
    gpu_probe = Lease(gpu_lock)
    worker.start()
    try:
        assert entered.wait(2)
        began = time.monotonic()
        worker.close(timeout=.02)
        assert time.monotonic() - began < .5
        assert stop_entered.wait(1)
        assert not controller_probe.acquire() and not gpu_probe.acquire()
        run_release.set()
        wait_until(worker._worker_done.is_set)
        assert not controller_probe.acquire()  # The separate stop call still owns the lifecycle.
        stop_release.set()
        wait_until(controller_probe.acquire)
        assert store.job(pending['id'])['state'] == 'cancelled'
    finally:
        run_release.set()
        stop_release.set()
        worker.close(timeout=2)
        controller_probe.close()
        gpu_probe.close()


def test_cancel_linearizes_after_concurrent_completion_transaction(workspace):
    store, project, _ = workspace
    pending = store.enqueue(project, {'task': 'write'})
    store.status(pending['id'], 'generating', 'Generating')
    worker = worker_for(store, FakeRuntime(store))
    started, finished = threading.Event(), threading.Event()
    def cancel():
        started.set()
        worker.cancel(pending['id'])
        finished.set()
    with store.connect() as db:
        db.execute('BEGIN IMMEDIATE')
        db.execute("UPDATE jobs SET state='completed',message='Saved' WHERE id=?", (pending['id'],))
        thread = threading.Thread(target=cancel)
        thread.start()
        assert started.wait(1)
        time.sleep(.04)  # Cancellation waits for the completion writer, not an old read snapshot.
        assert not finished.is_set()
    assert finished.wait(2)
    thread.join()
    after = store.job(pending['id'])
    assert after['state'] == 'completed' and after['cancel'] == 0
    assert not worker.runtime.stops


def test_shutdown_during_admission_does_not_start_a_runtime(workspace):
    store, project, _ = workspace
    pending = store.enqueue(project, {'task': 'write'})
    runtime = FakeRuntime(store)
    original_status = store.status
    admission, release = threading.Event(), threading.Event()
    def status(identity, state, message, **fields):
        if state == 'preparing':
            admission.set()
            assert release.wait(3)
        return original_status(identity, state, message, **fields)
    store.status = status
    worker = worker_for(store, runtime)
    worker.start()
    try:
        assert admission.wait(2)
        assert store.job(pending['id'])['state'] == 'queued'
        worker.close(timeout=.02)
        release.set()
        wait_until(worker._worker_done.is_set)
        assert not runtime.runs
        assert store.job(pending['id'])['state'] == 'cancelled'
    finally:
        release.set()
        worker.close(timeout=2)


def test_repeat_cancel_does_not_duplicate_events_or_stop_calls(workspace):
    store, project, _ = workspace
    pending = store.enqueue(project, {'task': 'write'})
    worker = worker_for(store, FakeRuntime(store))
    worker.cancel(pending['id'])
    worker.cancel(pending['id'])
    assert store.job(pending['id'])['state'] == 'cancelled'
    assert len(store.rows('SELECT * FROM job_events WHERE job=?', (pending['id'],))) == 1


def test_busy_gpu_waiting_does_not_flood_events(workspace, monkeypatch):
    store, project, _ = workspace
    pending = store.enqueue(project, {'task': 'write'})
    runtime = FakeRuntime(store)
    monkeypatch.setattr(queue, 'gpu_status', lambda: {'available': False, 'message': 'Another task is using the GPU.'})
    worker = worker_for(store, runtime)
    worker.start()
    try:
        wait_until(lambda: runtime.preflights >= 4)
        assert not runtime.runs
        assert len(store.rows('SELECT * FROM job_events WHERE job=?', (pending['id'],))) == 1
    finally:
        worker.close()


def test_runtime_failure_requires_recovery_before_next_job(workspace):
    store, project, _ = workspace
    first = store.enqueue(project, {'task': 'write'})
    second = store.enqueue(project, {'task': 'write'})
    runtime = FakeRuntime(store)
    recovery = threading.Event()
    recovery.set()
    original_run = runtime.run
    def run(job):
        if job['id'] == first['id']:
            recovery.clear()
            raise RuntimeFailure('Tool failed during execution')
        return original_run(job)
    def cleanup():
        if not recovery.is_set():
            raise RuntimeFailure('Release could not be verified')
    runtime.run, runtime.cleanup_owned = run, cleanup
    worker = worker_for(store, runtime)
    worker.start()
    try:
        wait_until(lambda: worker.diagnostics()['state'] == 'recovery_blocked')
        assert store.job(first['id'])['state'] == 'failed'
        assert store.job(second['id'])['state'] == 'queued' and not runtime.runs
        recovery.set()
        wait_until(lambda: store.job(second['id'])['state'] == 'completed')
    finally:
        recovery.set()
        worker.close()


def test_lease_reacquire_is_idempotent_and_release_allows_another_owner(tmp_path):
    first, second = Lease(tmp_path / 'lock'), Lease(tmp_path / 'lock')
    try:
        assert first.acquire()
        descriptor = first.fd
        assert first.acquire() and first.fd == descriptor
        assert not os.get_inheritable(descriptor)
        assert not second.acquire()
        first.close()
        assert second.acquire()
    finally:
        first.close()
        second.close()


def test_lease_rejects_symlink_and_nonregular_file(tmp_path):
    (tmp_path / 'target').write_text('')
    (tmp_path / 'link').symlink_to(tmp_path / 'target')
    with pytest.raises(OSError):
        Lease(tmp_path / 'link').acquire()
    os.mkfifo(tmp_path / 'fifo')
    with pytest.raises(RuntimeError, match='regular'):
        Lease(tmp_path / 'fifo').acquire()
