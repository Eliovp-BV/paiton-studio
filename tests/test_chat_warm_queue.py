"""CPU lifecycle checks; these fixtures do not represent model inference."""
import time
import pytest
from studio import queue
from studio.resources import Lease
from studio.store import Store
from studio.runtime import RuntimeFailure

class WarmRuntime:
    def __init__(self,store):
        self.store=store;self.warm=False;self.expires=False;self.foreign=False;self.fail_stop=False;self.events=[]
    def preflight(self,request):pass
    def warm_for(self,request):return self.warm and request.get('chat',False)
    def warm_live(self):return self.warm
    def warm_expired(self):return self.expires
    def warm_owns_gpu(self,status):return not self.foreign
    def drop_warm(self):
        self.events.append('stop')
        if self.fail_stop:raise RuntimeFailure('fixture stop failed')
        self.warm=False
    def run(self,job):
        self.events.append('reuse' if self.warm else 'load')
        self.warm=job['request'].get('chat',False)
        path=self.store.root/'fixture.txt';path.write_text('CPU fixture')
        return 'text',path,{}

def ready(tmp_path,monkeypatch):
    store=Store(tmp_path/'data');project=store.create_project()['id'];lock=tmp_path/'gpu.lock'
    monkeypatch.setattr(queue,'gpu_lease',lambda:Lease(lock));monkeypatch.setattr(queue,'gpu_status',lambda:{'available':True,'supported':True})
    runtime=WarmRuntime(store);worker=queue.Worker(store,runtime)
    return store,project,lock,runtime,worker

def test_reuse_holds_lease_and_switch_stops_first(tmp_path,monkeypatch):
    store,project,lock,runtime,worker=ready(tmp_path,monkeypatch)
    for _ in range(2):worker._run_job(store.enqueue(project,{'task':'write','chat':True}))
    other=Lease(lock)
    try:
        assert not other.acquire()
        assert runtime.events==['load','reuse']
        worker._run_job(store.enqueue(project,{'task':'write','chat':False}))
        assert runtime.events==['load','reuse','stop','load']
        assert other.acquire()
    finally:other.close();worker._drop_warm()

def test_stop_failure_retains_lease(tmp_path,monkeypatch):
    store,project,lock,runtime,worker=ready(tmp_path,monkeypatch)
    worker._run_job(store.enqueue(project,{'task':'write','chat':True}));runtime.fail_stop=True
    other=Lease(lock)
    try:
        with pytest.raises(RuntimeFailure):worker._drop_warm()
        assert not other.acquire()
    finally:runtime.fail_stop=False;worker._drop_warm();other.close()

def test_foreign_gpu_activity_requeues_without_reuse(tmp_path,monkeypatch):
    store,project,lock,runtime,worker=ready(tmp_path,monkeypatch)
    worker._run_job(store.enqueue(project,{'task':'write','chat':True}));runtime.foreign=True
    job=store.enqueue(project,{'task':'write','chat':True});worker._run_job(job)
    assert store.job(job['id'])['state']=='queued'
    assert runtime.events==['load','stop'] and worker._warm_lease is None

def test_idle_expiration_and_shutdown_stop_warm_runtime(tmp_path,monkeypatch):
    store,project,lock,runtime,worker=ready(tmp_path,monkeypatch)
    worker.poll_seconds=.01;worker.start()
    try:
        job=store.enqueue(project,{'task':'write','chat':True})
        deadline=time.monotonic()+2
        while store.job(job['id'])['state']!='completed' and time.monotonic()<deadline:time.sleep(.01)
        assert runtime.warm
        runtime.expires=True
        while runtime.warm and time.monotonic()<deadline:time.sleep(.01)
        assert not runtime.warm
        runtime.expires=False
        job=store.enqueue(project,{'task':'write','chat':True})
        while store.job(job['id'])['state']!='completed' and time.monotonic()<deadline:time.sleep(.01)
        assert runtime.warm
    finally:worker.close()
    assert not runtime.warm and worker._warm_lease is None


def test_unavailable_tool_keeps_chat_ready_for_the_next_reply(tmp_path,monkeypatch):
    store,project,lock,runtime,worker=ready(tmp_path,monkeypatch)
    worker._run_job(store.enqueue(project,{'task':'write','chat':True}))
    def preflight(request):
        if request['task']=='image':
            raise RuntimeFailure('The local image package is missing.')
    runtime.preflight=preflight
    unavailable=store.enqueue(project,{'task':'image','chat':False})
    other=Lease(lock)
    try:
        worker._run_job(unavailable)
        assert store.job(unavailable['id'])['state']=='failed'
        assert runtime.events==['load'] and runtime.warm
        assert not other.acquire()
        worker._run_job(store.enqueue(project,{'task':'write','chat':True}))
        assert runtime.events==['load','reuse']
    finally:worker._drop_warm();other.close()


def test_cancelled_snapshot_never_switches_or_checks_a_tool(tmp_path,monkeypatch):
    store,project,lock,runtime,worker=ready(tmp_path,monkeypatch)
    worker._run_job(store.enqueue(project,{'task':'write','chat':True}))
    cancelled=store.enqueue(project,{'task':'image','chat':False})
    worker.cancel(cancelled['id'])
    def preflight(request):raise AssertionError('Cancelled work must not be prepared.')
    runtime.preflight=preflight
    try:
        worker._run_job(cancelled)
        assert store.job(cancelled['id'])['state']=='cancelled'
        assert runtime.events==['load'] and runtime.warm
    finally:worker._drop_warm()


def test_cancellation_during_preflight_keeps_chat_ready(tmp_path,monkeypatch):
    store,project,lock,runtime,worker=ready(tmp_path,monkeypatch)
    worker._run_job(store.enqueue(project,{'task':'write','chat':True}))
    cancelled=store.enqueue(project,{'task':'image','chat':False})
    runtime.preflight=lambda request:worker.cancel(cancelled['id'])
    try:
        worker._run_job(cancelled)
        assert store.job(cancelled['id'])['state']=='cancelled'
        assert runtime.events==['load'] and runtime.warm
    finally:worker._drop_warm()


def test_switch_stop_failure_requires_recovery_and_keeps_lease(tmp_path,monkeypatch):
    store,project,lock,runtime,worker=ready(tmp_path,monkeypatch)
    worker._run_job(store.enqueue(project,{'task':'write','chat':True}))
    worker._recovery_needed=False
    runtime.fail_stop=True
    pending=store.enqueue(project,{'task':'image','chat':False})
    other=Lease(lock)
    try:
        worker._run_job(pending)
        assert store.job(pending['id'])['state']=='failed'
        assert worker._recovery_needed and not other.acquire()
        assert runtime.events==['load','stop']
    finally:runtime.fail_stop=False;worker._drop_warm();other.close()
