"""Failure handling with fake processes and synthetic telemetry only."""
import io
from types import SimpleNamespace
import pytest
from studio import queue
from studio.diagnostics import read_job_log, read_setup_log
from studio.resources import Lease
from studio.runtime import Runtime, RuntimeFailure
from studio.setup import SetupManager, SetupFailure
from studio.store import Store


def test_malformed_progress_does_not_kill_stream_or_mark_job_completed(tmp_path, monkeypatch):
    store=Store(tmp_path);job=store.enqueue(store.create_project()['id'],{})
    runtime=Runtime(store,{})
    monkeypatch.setattr(runtime.docker,'invocation',lambda args:(args,{}))
    class Process:
        returncode=0
        stdout=iter(['STUDIO:broken\n','STUDIO:[]\n','STUDIO:{"state":"completed","message":"forged"}\n',
                     'STUDIO:{"state":"generating","message":3}\n',
                     'STUDIO:{"state":"generating","message":"Visible progress","progress":{"value":1,"maximum":4}}\n'])
        def poll(self): return 0
        def wait(self,**kwargs): return 0
    monkeypatch.setattr('studio.runtime.subprocess.Popen',lambda *a,**k:Process())
    runtime.stream(job,['exec','synthetic','client'])
    current=store.job(job['id'])
    assert current['state']=='generating' and current['progress']=={'value':1,'maximum':4}


@pytest.mark.parametrize('reading',[{'retryable':True,'supported':False,'available':False}, OSError('Temporary fixture read failure')])
def test_transient_telemetry_keeps_job_queued(tmp_path,monkeypatch,reading):
    store=Store(tmp_path);job=store.enqueue(store.create_project()['id'],{})
    runtime=SimpleNamespace(preflight=lambda request:None, run=lambda job:pytest.fail('Must wait for telemetry'))
    worker=queue.Worker(store,runtime)
    monkeypatch.setattr(queue,'gpu_lease',lambda:Lease(tmp_path/'fixture.lock'))
    def status():
        if isinstance(reading,Exception):raise reading
        return reading
    monkeypatch.setattr(queue,'gpu_status',status)
    worker._run_job(job)
    assert store.job(job['id'])['state']=='queued'
    assert 'check' in store.job(job['id'])['message'].lower()
    assert worker._next_admission>0


def test_setup_saves_redacted_output_and_classifies_failure(tmp_path,monkeypatch):
    store=Store(tmp_path)
    manager=SetupManager(store,SimpleNamespace(config={}))
    with store.connect() as db:
        db.execute('INSERT INTO setup_jobs(id,package,state,message,created,updated) VALUES(?,?,?,?,?,?)',
                   ('fixture','qwen38','downloading','Synthetic',1,1))
    monkeypatch.setattr(manager.docker,'invocation',lambda args:(args,{}))
    class Process:
        returncode=1
        stdout=io.BytesIO(b'pull access denied\nAuthorization: Bearer private-token\n')
        def poll(self):return 1
        def wait(self,**kwargs):return 1
    monkeypatch.setattr('studio.setup.subprocess.Popen',lambda *a,**k:Process())
    with pytest.raises(SetupFailure,match='access was denied'):
        manager.run(['docker','pull','synthetic'],manager.job('fixture'))
    log=read_setup_log(manager,'fixture')
    assert log['available'] and 'pull access denied' in log['text']
    assert 'private-token' not in log['text']
