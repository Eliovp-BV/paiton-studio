"""Qwen lifecycle and request isolation; fixture outputs are not inference."""
from copy import deepcopy
import json
import re
import subprocess
from types import SimpleNamespace

import pytest

from studio import queue
from studio.registry import compatible_profiles, profile
from studio.resources import Lease
from studio.runtime import Runtime, RuntimeFailure
from studio.store import Store


@pytest.fixture
def qwen_runtime(tmp_path,monkeypatch):
    store=Store(tmp_path/'data')
    runtime=Runtime(store,{'qwen38_image':'pinned-qwen-image'})
    worker=queue.Worker(store,runtime)
    clock=[1000.0]
    monkeypatch.setattr('studio.runtime.time.monotonic',lambda:clock[0])
    monkeypatch.setattr('studio.runtime.compatibility',lambda *a:{'compatible':True})
    monkeypatch.setattr('studio.runtime.gpu_status',lambda:{'available':True,'supported':True})
    monkeypatch.setattr(queue,'gpu_status',lambda:{'available':True,'supported':True})
    monkeypatch.setattr(queue,'gpu_lease',lambda:Lease(tmp_path/'gpu.lock'))
    monkeypatch.setattr(runtime,'preflight',lambda request:'pinned-qwen-image')
    monkeypatch.setattr(runtime,'chat_source',lambda *a:([],{}))
    monkeypatch.setattr(runtime,'warm_owns_gpu',lambda *a:True)
    monkeypatch.setattr(runtime,'wait_ready',lambda *a:None)
    state=SimpleNamespace(store=store,runtime=runtime,worker=worker,clock=clock,
                          starts=[],stops=[],bodies=[],tokenized=[],token_count=100,
                          mode='complete',lock=tmp_path/'gpu.lock')
    def http(container,port,path,body,**kwargs):
        assert path=='/tokenize' and port==8000
        state.tokenized.append(deepcopy(body))
        return {'count':state.token_count}
    monkeypatch.setattr(runtime,'http',http)
    monkeypatch.setattr(runtime,'stop',lambda container:state.stops.append(container) if container else None)
    def start(job,image,args,**kwargs):
        container=f'cpu-owned-{len(state.starts)}'
        state.starts.append((container,image,args,kwargs))
        store.status(job['id'],'loading','CPU lifecycle fixture',container=container)
        return container,store.root/'jobs'/job['id']
    monkeypatch.setattr(runtime,'start',start)
    def command(args,**kwargs):
        if args[0]=='exec':
            identity=re.search(r'/studio-jobs/([a-f0-9]{32})/writing-request.json',args[-1]).group(1)
            directory=store.root/'jobs'/identity
            body=json.loads((directory/'writing-request.json').read_text())['body']
            state.bodies.append((identity,body))
            if state.mode=='cancel':
                worker.cancel(identity)
            elif state.mode=='fail':
                return subprocess.CompletedProcess(args,1,'','CPU request failure')
            elif state.mode!='missing-output':
                result=dict(choices=[dict(message=dict(content=f'CPU fixture for {identity}'),finish_reason='stop')])
                (directory/'writing-result.json').write_text(json.dumps(result))
        return subprocess.CompletedProcess(args,0,'','')
    monkeypatch.setattr(runtime,'command',command)
    yield state
    worker._drop_warm()


def request(identity='qwen38-writing',**overrides):
    return dict(task='write',profile=profile(identity,'write'),prompt='Project A notes',
                seed=71,**overrides)


def test_writing_website_writing_reuses_model_with_fresh_project_context(qwen_runtime):
    state=qwen_runtime
    first=state.store.create_project('Project A')['id']
    second=state.store.create_project('Project B')['id']
    a=request(context='Private A marker CEDAR-731')
    b=request('qwen38-website',messages=[
        {'role':'system','content':'Return the requested website plan.'},
        {'role':'user','content':'Project B public brief OCEAN-824'}])
    results=[]
    for project,body in ((first,a),(second,b),(first,a)):
        job=state.store.enqueue(project,body)
        state.worker._run_job(job)
        completed=state.store.job(job['id'])
        assert completed['state']=='completed'
        assert completed['request']==body
        asset=state.store.asset(completed['asset'])
        assert asset['project']==project
        assert state.store.file(asset).read_text()==f"CPU fixture for {job['id']}"
        results.append(completed['asset'])
    assert len(set(results))==3
    assert len(state.starts)==1 and state.stops==[]
    bodies=[body for _,body in state.bodies]
    assert bodies[0]==bodies[2]
    assert 'CEDAR-731' not in json.dumps(bodies[1])
    assert 'OCEAN-824' not in json.dumps(bodies[0])
    assert bodies[1]['messages']==b['messages']
    assert [x['max_tokens'] for x in bodies]==[2048,3500,2048]
    assert [x['temperature'] for x in bodies]==[.6,.2,.6]
    assert all(x['seed']==71 and x['model']=='qwen38' and x['chat_template_kwargs']=={'enable_thinking':False} for x in bodies)
    assert state.tokenized==[{k:b[k] for k in ('model','messages','chat_template_kwargs')} for b in bodies]
    assert state.starts[0][2]==[]  # Preserve the public Qwen launcher contract.
    other=Lease(state.lock)
    try:assert not other.acquire()  # Ready model retains exclusive admission.
    finally:other.close()


def test_qwen_reuse_does_not_expand_model_roles(qwen_runtime):
    assert 'qwen38' in {p['package'] for p in compatible_profiles('write')}
    assert 'qwen38' in {p['package'] for p in compatible_profiles('website')}
    assert 'qwen38' not in {p['package'] for p in compatible_profiles('chat')}
    assert 'qwen38' not in {p['package'] for p in compatible_profiles('code')}


def test_revision_image_and_expiry_invalidate_retained_qwen(qwen_runtime):
    state=qwen_runtime
    project=state.store.create_project()['id'];a=request()
    state.worker._run_job(state.store.enqueue(project,a))
    assert state.runtime.warm_for(a)
    altered=deepcopy(a);altered['profile']['revision']='another-checkpoint'
    assert not state.runtime.warm_for(altered)
    state.runtime.config['qwen38_image']='another-runtime-image'
    assert not state.runtime.warm_for(a)
    state.runtime.config['qwen38_image']='pinned-qwen-image'
    state.clock[0]+=121
    assert state.runtime.warm_expired() and not state.runtime.warm_for(a)
    state.worker._run_job(state.store.enqueue(project,a))
    assert len(state.starts)==2 and state.stops==['cpu-owned-0']
    assert state.runtime.warm_for(a)


@pytest.mark.parametrize('mode',['cancel','fail','missing-output'])
def test_cancelled_or_failed_reused_request_cannot_return_old_output(qwen_runtime,mode):
    state=qwen_runtime
    project=state.store.create_project()['id'];a=request()
    state.worker._run_job(state.store.enqueue(project,a))
    state.mode=mode
    failed=state.store.enqueue(project,a)
    state.worker._run_job(failed)
    saved=state.store.job(failed['id'])
    assert saved['state']==('cancelled' if mode=='cancel' else 'failed')
    assert saved['asset'] is None
    assert not state.runtime.warm_live()
    assert 'cpu-owned-0' in state.stops
    state.mode='complete'
    retry=state.store.enqueue(project,a)
    state.worker._run_job(retry)
    assert state.store.job(retry['id'])['state']=='completed'
    assert len(state.starts)==2


def test_invalid_next_tool_preserves_qwen_but_switch_releases_it(qwen_runtime,monkeypatch):
    state=qwen_runtime
    project=state.store.create_project()['id'];a=request()
    state.worker._run_job(state.store.enqueue(project,a))
    def missing(request):raise RuntimeFailure('Next package is not installed.')
    monkeypatch.setattr(state.runtime,'preflight',missing)
    failed=state.store.enqueue(project,{'task':'image','profile':profile('image-standard','image')})
    state.worker._run_job(failed)
    assert state.store.job(failed['id'])['state']=='failed'
    assert state.stops==[] and state.runtime.warm_for(a)
    state.worker._drop_warm()
    assert state.stops==['cpu-owned-0'] and not state.runtime.warm_live()
    other=Lease(state.lock)
    try:assert other.acquire()
    finally:other.close()


@pytest.mark.parametrize('invalid',[
    request(messages=[{'role':'user','content':'Writing-only profile cannot plan a site.'}]),
    request('qwen38-website',messages=[{'role':'tool','content':'Invalid internal role.'}]),
    request('qwen38-website',messages=[{'role':'user','content':{'invalid':'content'}}]),
    {'task':'write','profile':profile('gptoss-writing','write'),'prompt':'Draft notes','reasoning_effort':'unlimited'},
])
def test_invalid_internal_body_fails_before_releasing_ready_model(qwen_runtime,monkeypatch,invalid):
    state=qwen_runtime
    project=state.store.create_project()['id'];a=request()
    state.worker._run_job(state.store.enqueue(project,a))
    before=len(state.bodies)
    bad=state.store.enqueue(project,invalid)
    with pytest.raises(ValueError):state.runtime.run(bad)
    assert len(state.starts)==1 and state.stops==[]
    assert len(state.bodies)==before and state.runtime.warm_for(a)
    # The queue also validates before switching packages, rather than waiting
    # until Runtime.run after releasing the retained Qwen model.
    monkeypatch.setattr('studio.readiness.host_compatibility',lambda:{'compatible':True})
    monkeypatch.setattr(state.runtime,'preflight',Runtime.preflight.__get__(state.runtime))
    state.worker._run_job(bad)
    assert state.store.job(bad['id'])['state']=='failed'
    assert len(state.starts)==1 and state.stops==[]
    assert len(state.bodies)==before and state.runtime.warm_for(a)


def test_gpt_browser_presence_does_not_extend_writing_only_qwen(qwen_runtime):
    state=qwen_runtime
    project=state.store.create_project()['id'];a=request()
    state.worker._run_job(state.store.enqueue(project,a))
    state.clock[0]+=110
    state.runtime.touch_chat()
    assert state.runtime.memory_status()['retained_model']['idle_remaining_seconds']==10
    state.clock[0]+=11
    assert state.runtime.warm_expired() and not state.runtime.warm_for(a)
    assert state.runtime.memory_status()['retained_model']['state']=='releasing'


@pytest.mark.parametrize('token_count',[4693,10000,-1,True,None])
def test_context_admission_rejects_without_generation_and_cleans_owned_runtime(qwen_runtime,token_count):
    state=qwen_runtime
    project=state.store.create_project()['id']
    state.token_count=token_count
    a=request('qwen38-website',messages=[{'role':'user','content':'The original full source text.'}])
    job=state.store.enqueue(project,a)
    state.worker._run_job(job)
    saved=state.store.job(job['id'])
    assert saved['state']=='failed' and saved['asset'] is None
    assert 'No generation was started' in saved['message'] or 'no generation was started' in saved['message']
    assert state.tokenized[0]['messages']==a['messages']
    assert state.bodies==[] and state.stops==['cpu-owned-0']
    assert not state.runtime.warm_live()
    assert not (state.store.root/'jobs'/job['id']/'writing-result.json').exists()
    assert saved['request']==a


def test_exact_context_boundary_accepts_complete_original_request(qwen_runtime):
    state=qwen_runtime
    project=state.store.create_project()['id']
    state.token_count=4692  # 8192 context minus the unchanged 3500 output cap.
    a=request('qwen38-website',messages=[{'role':'user','content':'Complete original source.'}])
    job=state.store.enqueue(project,a)
    state.worker._run_job(job)
    assert state.store.job(job['id'])['state']=='completed'
    assert state.bodies[0][1]['messages']==a['messages']
    assert state.bodies[0][1]['max_tokens']==3500


def test_oversize_warm_request_preserves_server_lease_and_short_retry(qwen_runtime):
    state=qwen_runtime
    state.worker._recovery_needed=False
    project=state.store.create_project()['id'];a=request()
    first=state.store.enqueue(project,a)
    state.worker._run_job(first)
    retained=deepcopy(state.runtime._warm)
    state.token_count=7000
    rejected=state.store.enqueue(project,a)
    state.worker._run_job(rejected)
    failed=state.store.job(rejected['id'])
    assert failed['state']=='failed' and failed['asset'] is None
    assert 'Nothing was truncated' in failed['message']
    assert len(state.starts)==1 and len(state.bodies)==1 and state.stops==[]
    assert state.runtime._warm==retained and not state.worker._recovery_needed
    assert not (state.store.root/'jobs'/rejected['id']/'writing-request.json').exists()
    other=Lease(state.lock)
    try:assert not other.acquire()
    finally:other.close()
    state.token_count=100
    shortened=state.store.enqueue(project,a)
    state.worker._run_job(shortened)
    assert state.store.job(shortened['id'])['state']=='completed'
    assert len(state.starts)==1 and len(state.bodies)==2 and state.stops==[]
    assert state.bodies[-1][0]==shortened['id']
    assert state.bodies[-1][1]==state.bodies[0][1]


@pytest.mark.parametrize('failure',['invalid-count','network'])
def test_uncertain_tokenizer_failure_still_stops_warm_runtime(qwen_runtime,monkeypatch,failure):
    state=qwen_runtime
    state.worker._recovery_needed=False
    project=state.store.create_project()['id'];a=request()
    state.worker._run_job(state.store.enqueue(project,a))
    if failure=='network':
        def unavailable(*args,**kwargs):raise RuntimeFailure('The tokenizer did not respond.')
        monkeypatch.setattr(state.runtime,'http',unavailable)
    else:
        state.token_count=True
    failed=state.store.enqueue(project,a)
    state.worker._run_job(failed)
    assert state.store.job(failed['id'])['state']=='failed'
    assert len(state.bodies)==1 and state.stops==['cpu-owned-0']
    assert not state.runtime.warm_live() and state.worker._recovery_needed


def test_cold_oversize_cleanup_failure_requires_recovery(qwen_runtime,monkeypatch):
    state=qwen_runtime
    state.worker._recovery_needed=False
    state.token_count=9000
    project=state.store.create_project()['id']
    stopped=state.runtime.stop
    def fail_stop(container):raise RuntimeFailure('CPU fixture stop failed.')
    monkeypatch.setattr(state.runtime,'stop',fail_stop)
    try:
        failed=state.store.enqueue(project,request())
        state.worker._run_job(failed)
        assert state.store.job(failed['id'])['message']=='CPU fixture stop failed.'
        assert state.worker._recovery_needed and state.bodies==[]
    finally:monkeypatch.setattr(state.runtime,'stop',stopped)


def test_warm_failure_to_stop_retains_lease_for_recovery(qwen_runtime,monkeypatch):
    state=qwen_runtime
    state.worker._recovery_needed=False
    project=state.store.create_project()['id'];a=request()
    state.worker._run_job(state.store.enqueue(project,a))
    state.token_count=None  # Uncertain response still requires conservative shutdown.
    stopped=state.runtime.stop
    def fail_stop(container):raise RuntimeFailure('CPU fixture stop failed.')
    monkeypatch.setattr(state.runtime,'stop',fail_stop)
    other=Lease(state.lock)
    try:
        failed=state.store.enqueue(project,a)
        state.worker._run_job(failed)
        assert state.store.job(failed['id'])['state']=='failed'
        assert state.worker._recovery_needed and state.runtime.warm_live()
        assert not other.acquire() and len(state.bodies)==1
    finally:
        monkeypatch.setattr(state.runtime,'stop',stopped)
        other.close()
