"""Owned text cancellation with fake Docker; no GPU or model is accessed."""
import json
import subprocess
import time
from types import SimpleNamespace

import pytest

from scripts.cancellable_stream import _atomic_json
from studio import queue
from studio.registry import profile
from studio.resources import Lease
from studio.runtime import Cancelled, Runtime, RuntimeFailure
from studio.store import Store


@pytest.fixture
def running(tmp_path, monkeypatch):
    store=Store(tmp_path/'data');project=store.create_project()['id']
    image='sha256:'+'a'*64
    runtime=Runtime(store,{'minicpm5_image':image})
    worker=queue.Worker(store,runtime);worker._recovery_needed=False
    state=SimpleNamespace(store=store,project=project,runtime=runtime,worker=worker,
        mode='cancel',starts=[],stops=[],processes=[],alive=set(),health=True,stop_failure=False,
        release=False,internal=False,partial='A short final partial reply.',lock=tmp_path/'gpu.lock')
    runtime.text_cancel_timeout=.08
    monkeypatch.setattr('studio.runtime.gpu_status',lambda:{'available':True,'supported':True})
    monkeypatch.setattr('studio.runtime.compatibility',lambda *a:{'compatible':True})
    monkeypatch.setattr(queue,'gpu_status',lambda:{'available':True,'supported':True})
    monkeypatch.setattr(queue,'gpu_lease',lambda:Lease(state.lock))
    monkeypatch.setattr(runtime,'preflight',lambda request:image)
    monkeypatch.setattr(runtime,'chat_source',lambda *a:([],{}))
    monkeypatch.setattr(runtime,'owned',lambda container:container in state.alive)
    monkeypatch.setattr(runtime,'warm_owns_gpu',lambda *a:True)
    monkeypatch.setattr(runtime,'wait_ready',lambda *a:None)
    def start(job,*args,**kwargs):
        container='owned-'+str(len(state.starts))
        state.starts.append(container);state.alive.add(container)
        store.status(job['id'],'loading','Fixture loading',container=container)
        return container,store.root/'jobs'/job['id']
    monkeypatch.setattr(runtime,'start',start)
    def stop(container):
        if not container:return
        state.stops.append(container)
        if state.stop_failure:raise RuntimeFailure('Fixture stop cannot be confirmed.')
        state.alive.discard(container)
    monkeypatch.setattr(runtime,'stop',stop)
    # Run the fallback synchronously: the existing queue hardening suite covers
    # stop-thread lifecycle, while these assertions focus on exact ownership.
    monkeypatch.setattr(worker,'_request_stop',lambda identity,container:runtime.stop(container))
    def command(args,**kwargs):
        if args[0]=='exec' and args[-1]=='/studio/http_bridge.py':
            request=json.loads(kwargs['input'])
            if request['path']=='/health' and not state.health:
                raise RuntimeFailure('Fixture server unhealthy after cancellation.')
            return subprocess.CompletedProcess(args,0,json.dumps({'count':20}) if request['path']=='/tokenize' else '{}','')
        return subprocess.CompletedProcess(args,0,'','')
    monkeypatch.setattr(runtime,'command',command)
    monkeypatch.setattr(runtime.docker,'invocation',lambda args:(args,{}))

    class Process:
        def __init__(self,command,**kwargs):
            self.stdout=iter([]);self.returncode=None;self.polls=0;self.terminated=False
            self.directory=runtime._active_text['invocation']['directory']
            self.request=json.loads((self.directory/'writing-request.json').read_text())
            self.identity=runtime._active_text['job'];state.processes.append(self)
            if state.mode=='complete':self.complete()
        def ack(self,kind):
            nonce='f'*32 if state.mode=='stale' else self.request['invocation_nonce']
            _atomic_json(self.directory/'stream-ack.json',dict(nonce=nonce,state=kind,
                connection_closed=True,partial=state.partial,closed_at=time.time()))
        def complete(self):
            choice=getattr(state,'choice',dict(message=dict(role='assistant',content='Completed synthetic reply.'),finish_reason='stop'))
            nonce='e'*32 if state.mode=='closed-stale-result' else self.request['invocation_nonce']
            _atomic_json(self.directory/'writing-result.json',dict(invocation_nonce=nonce,choices=[choice]))
            self.ack('closed');self.returncode=0
        def poll(self):
            if self.returncode is not None:return self.returncode
            self.polls+=1
            if self.polls==1:
                store.status(self.identity,'generating','Visible output',{'text':'Already visible.', 'context':{'input_tokens':20}})
                if state.release:runtime.request_release()
                worker.cancel(self.identity)
                return None
            if state.mode in ('closed-race','closed-stale-result'):self.complete()
            elif state.mode not in ('missing','stuck'):
                self.ack('error' if state.mode=='error' else 'cancelled')
                self.returncode=130
            elif state.mode=='stuck':self.ack('cancelled')
            return self.returncode
        def terminate(self):self.terminated=True;self.returncode=-15
        def kill(self):self.returncode=-9
        def wait(self,timeout=None):return self.returncode
    monkeypatch.setattr('studio.runtime.subprocess.Popen',Process)
    def enqueue():
        return store.enqueue(project,dict(task='write',runtime_image=image,profile=profile('minicpm5-chat','write'),
            chat_id='cpu-conversation',messages=[dict(role='user',content='A synthetic request')],prompt='Synthetic request',seed=7))
    state.enqueue=enqueue
    yield state
    state.stop_failure=False
    worker._drop_warm()


def test_cold_ready_stop_flushes_partial_keeps_lease_and_next_reply_reuses(running):
    state=running;job=state.enqueue()
    state.worker._run_job(job)
    saved=state.store.job(job['id'])
    assert saved['state']=='cancelled' and saved['progress']['text']==state.partial
    assert saved['progress']['context']=={'input_tokens':20}
    assert state.runtime.warm_for(job['request']) and not state.stops
    assert state.processes[0].returncode==130 and not state.processes[0].terminated
    other=Lease(state.lock)
    try:assert not other.acquire()
    finally:other.close()
    state.mode='complete'
    next_job=state.enqueue();state.worker._run_job(next_job)
    assert state.store.job(next_job['id'])['state']=='completed'
    assert len(state.starts)==1 and not state.stops
    assert state.processes[0].request['invocation_nonce']!=state.processes[1].request['invocation_nonce']


@pytest.mark.parametrize('mode',['missing','stale','error','stuck'])
def test_uncertain_acknowledgement_or_live_relay_stops_exact_container(running,mode):
    state=running;state.mode=mode;job=state.enqueue()
    state.worker._run_job(job)
    assert state.store.job(job['id'])['state']=='cancelled'
    assert state.stops==['owned-0'] and not state.runtime.warm_live()
    assert state.worker._warm_lease is None


def test_failed_health_after_ack_stops_instead_of_reusing(running):
    state=running;state.health=False;job=state.enqueue()
    state.worker._run_job(job)
    assert state.store.job(job['id'])['progress']['text']==state.partial
    assert state.stops==['owned-0'] and not state.runtime.warm_live()


def test_release_racing_with_stop_survives_first_cold_ready_reply(running):
    state=running;state.release=True;job=state.enqueue()
    state.worker._run_job(job)
    assert state.runtime.memory_status()['retained_model']['state']=='releasing'
    assert state.runtime._warm['release_requested'] and not state.runtime.warm_for(job['request'])
    assert state.worker._warm_lease is not None
    state.worker._drop_warm()
    assert state.stops==['owned-0'] and not state.runtime.warm_live()


def test_unconfirmed_fallback_stop_holds_lease_for_recovery(running):
    state=running;state.mode='missing';state.stop_failure=True;job=state.enqueue()
    state.worker._run_job(job)
    assert state.worker._recovery_needed
    assert state.runtime.memory_status()['retained_model']['state']=='releasing'
    assert state.worker._warm_lease is not None
    other=Lease(state.lock)
    try:assert not other.acquire()
    finally:other.close()


def test_loading_cancellation_cannot_claim_ready_retention(running,monkeypatch):
    state=running;job=state.enqueue()
    def loading(*args):
        state.worker.cancel(job['id'])
        state.runtime.check_cancel(job)
    monkeypatch.setattr(state.runtime,'wait_ready',loading)
    state.worker._run_job(job)
    assert state.store.job(job['id'])['state']=='cancelled'
    assert not state.runtime.warm_live() and not state.processes
    assert set(state.stops)=={'owned-0'}


def test_tokenizer_cancellation_hard_stops_without_waiting_for_stream_ack(running,monkeypatch):
    state=running;job=state.enqueue();original=state.runtime.command
    def command(args,**kwargs):
        if args[0]=='exec' and json.loads(kwargs['input'])['path']=='/tokenize':
            state.worker.cancel(job['id'])
            assert state.stops==['owned-0']
            return subprocess.CompletedProcess(args,1,'','tokenizer stopped')
        return original(args,**kwargs)
    monkeypatch.setattr(state.runtime,'command',command)
    state.worker._run_job(job)
    assert state.store.job(job['id'])['state']=='cancelled'
    assert not state.runtime.warm_live() and not state.processes


def test_stop_racing_completed_stream_requires_current_result_nonce(running):
    state=running;state.mode='closed-race';job=state.enqueue()
    state.worker._run_job(job)
    assert state.store.job(job['id'])['state']=='cancelled'
    assert state.runtime.warm_live() and not state.stops


def test_closed_ack_cannot_reuse_a_result_from_another_invocation(running):
    state=running;state.mode='closed-stale-result';job=state.enqueue()
    state.worker._run_job(job)
    assert state.store.job(job['id'])['state']=='cancelled'
    assert state.stops==['owned-0'] and not state.runtime.warm_live()


def test_internal_summary_ack_never_overwrites_visible_partial(running,monkeypatch):
    state=running;job=state.enqueue();original=state.runtime._stream_invocation
    def invocation(job,command):
        value=original(job,command)
        value['internal']=True
        return value
    monkeypatch.setattr(state.runtime,'_stream_invocation',invocation)
    state.partial='Private internal summary that must not be shown.'
    state.worker._run_job(job)
    assert state.store.job(job['id'])['progress']['text']=='Already visible.'
    assert state.runtime.warm_live() and not state.stops


def test_stop_at_completed_tool_round_prevents_side_effects_and_retains_server(running,monkeypatch):
    from studio import conversation_runner
    state=running;state.mode='complete';job=state.enqueue()
    job['request']['profile']=profile('qwen38-mxfp4-chat','write')
    from studio.qwen_mxfp4 import IMAGE
    state.runtime.preflight=lambda request:IMAGE
    state.runtime.config.update(qwen38_nvfp4_target_dir=str(state.store.root),
                                qwen38_mxfp4_draft_dir=str(state.store.root))
    job['request']['tools_enabled']=True
    state.choice=dict(message=dict(role='assistant',content='I will prepare a draft.',tool_calls=[
        dict(id='call-1',type='function',function=dict(name='create_draft',arguments='{}'))]),finish_reason='tool_calls')
    original=conversation_runner.record_request;executed=[]
    def record(*args,**kwargs):
        result=original(*args,**kwargs)
        if len(args)>5 and args[5] is not None:
            state.worker.cancel(job['id'])
        return result
    monkeypatch.setattr(conversation_runner,'record_request',record)
    monkeypatch.setattr(conversation_runner.ProjectTools,'execute',lambda *args:executed.append(args))
    state.worker._run_job(job)
    assert state.store.job(job['id'])['state']=='cancelled' and not executed, state.store.job(job['id'])['message']
    assert state.runtime.warm_live() and not state.stops


def test_queued_stop_keeps_existing_progress_without_starting_any_runtime(running):
    state=running;job=state.enqueue()
    state.worker.cancel(job['id']);state.worker._run_job(job)
    assert state.store.job(job['id'])['state']=='cancelled'
    assert not state.starts and not state.processes and not state.stops


def test_stop_during_completed_asset_save_keeps_the_file_and_idle_server(running,monkeypatch):
    state=running;state.mode='complete';job=state.enqueue();original=state.store.add_asset
    def add_asset(*args,**kwargs):
        value=original(*args,**kwargs)
        state.worker.cancel(job['id'])
        return value
    monkeypatch.setattr(state.store,'add_asset',add_asset)
    state.worker._run_job(job)
    saved=state.store.job(job['id'])
    assert saved['state']=='cancelled' and saved['asset']
    assert state.store.file(state.store.asset(saved['asset'])).read_text()=='Completed synthetic reply.'
    assert saved['progress']['text']==state.partial
    assert state.runtime.warm_live() and not state.stops


def test_partial_merge_is_transactional_and_does_not_resurrect_or_overwrite_completed(tmp_path):
    store=Store(tmp_path);project=store.create_project();job=store.enqueue(project['id'],{})
    worker=queue.Worker(store,SimpleNamespace())
    store.status(job['id'],'generating','Writing',{'text':'Existing partial.', 'context':{'input_tokens':4}})
    worker.cancel(job['id'])
    assert store.job(job['id'])['progress']['text']=='Existing partial.'
    store.save_partial(job['id'],'Final visible text.')
    store.status(job['id'],'generating','Late progress',{'text':'Wrong late callback'})
    store.status(job['id'],'cancelled','Stopped')
    result=store.job(job['id'])
    assert result['state']=='cancelled' and result['progress']=={'text':'Final visible text.', 'context':{'input_tokens':4}}
    complete=store.enqueue(project['id'],{});store.status(complete['id'],'completed','Done')
    store.save_partial(complete['id'],'Cannot overwrite completed output')
    assert store.job(complete['id'])['progress'] is None
