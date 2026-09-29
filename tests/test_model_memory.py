"""CPU lifecycle fixtures; no model execution or performance claim."""
import json
import subprocess

import pytest

from studio.registry import profile
from studio.runtime import Runtime, RuntimeFailure
from studio.store import Store


@pytest.fixture
def clock_runtime(tmp_path, monkeypatch):
    clock=[1000.0]
    monkeypatch.setattr('studio.runtime.time.monotonic',lambda:clock[0])
    runtime=Runtime(Store(tmp_path),{'gptoss_image':'pinned-image'})
    def forbid(*args,**kwargs):
        raise AssertionError('Memory preference/status must not invoke Docker.')
    monkeypatch.setattr(runtime,'command',forbid)
    return clock,runtime


def retained(runtime, since=1000):
    runtime._warm=dict(package='gptoss',revision='revision',image='pinned-image',
                       container='private-container-id',since=since)


def test_policy_does_not_load_and_only_accepts_supported_choices(clock_runtime):
    clock,runtime=clock_runtime
    assert runtime.warm_seconds==900 and runtime.memory_status()['keep_ready_minutes']==15
    for minutes in (60,-1,15,60):
        runtime.configure_memory_policy(minutes)
        status=runtime.memory_status()
        assert status['keep_ready_minutes']==minutes
        assert status['retained_model'] is None
        assert runtime._chat_active_at==0
        assert 'ram_resume_supported' not in status
        assert set(status['retention_package_ids'])=={'gptoss','minicpm5-2b','qwen38','qwen38-mxfp4'}
    for invalid in (0,-2,1,2,3,5,30,True,15.0,'15',None):
        with pytest.raises(ValueError):runtime.configure_memory_policy(invalid)
    assert runtime.warm_seconds==3600


def test_policy_adjusts_deadlines_without_resetting_idle_clock(clock_runtime):
    clock,runtime=clock_runtime
    retained(runtime)
    clock[0]=1010
    runtime.touch_chat()
    clock[0]=1040
    assert runtime.memory_status()['retained_model']['idle_remaining_seconds']==870
    runtime.configure_memory_policy(60)
    assert runtime.memory_status()['retained_model']['idle_remaining_seconds']==3570
    runtime.configure_memory_policy(-1)
    assert runtime.memory_status()['retained_model']['idle_remaining_seconds'] is None
    runtime.configure_memory_policy(15)
    assert runtime._warm['since']==1000 and runtime._chat_active_at==1010
    assert runtime.memory_status()['retained_model']['idle_remaining_seconds']==870
    clock[0]=1911
    status=runtime.memory_status()['retained_model']
    assert status['state']=='releasing' and status['idle_remaining_seconds']==0
    assert runtime.warm_live() and runtime.warm_expired()
    assert not runtime.warm_for({'profile':{'package':'gptoss','revision':'revision'}})


def test_until_released_never_expires_idle_but_still_releases_on_request(clock_runtime,monkeypatch):
    clock,runtime=clock_runtime
    runtime.configure_memory_policy(-1)
    retained(runtime)
    request={'profile':{'package':'gptoss','revision':'revision'}}
    for now in (1000+3600,1000+30*24*3600):
        clock[0]=now
        status=runtime.memory_status()
        assert status['keep_ready_minutes']==-1
        assert status['retained_model']['state']=='ready'
        assert status['retained_model']['idle_remaining_seconds'] is None
        assert not runtime.warm_expired() and runtime.warm_for(request)
    # A timed policy applies to the original idle clock; no expiry restores readiness.
    runtime.configure_memory_policy(15)
    assert runtime.warm_expired() and runtime.memory_status()['retained_model']['state']=='releasing'
    runtime.configure_memory_policy(-1)
    assert not runtime.warm_expired() and runtime.memory_status()['retained_model']['state']=='ready'
    assert runtime.request_release()['retained_model']['state']=='releasing'
    assert runtime.warm_expired() and not runtime.warm_for(request)
    runtime.touch_chat()
    assert runtime.warm_expired()
    monkeypatch.setattr(runtime,'stop',lambda container:None)
    runtime.drop_warm()
    assert runtime.memory_status()['retained_model'] is None


def test_status_is_sanitized_and_presence_never_preloads(clock_runtime):
    clock,runtime=clock_runtime
    runtime.touch_chat()
    assert runtime.memory_status()['retained_model'] is None
    retained(runtime)
    status=runtime.memory_status()['retained_model']
    assert set(status)=={'package','model','runtime_image','state','idle_remaining_seconds'}
    assert status['runtime_image']=='pinned-image'
    assert 'GPT' in status['model'] and status['state']=='ready'
    assert 'private-container-id' not in json.dumps(status)
    assert 'revision' not in status and 'image' not in status


def test_stop_reports_releasing_and_failure_preserves_record(clock_runtime,monkeypatch):
    clock,runtime=clock_runtime
    retained(runtime)
    def fail(container):
        assert container=='private-container-id'
        assert runtime.memory_status()['retained_model']['state']=='releasing'
        # Reading status while shutdown runs must not wait for Docker.
        assert not runtime.warm_for({'profile':{'package':'gptoss','revision':'revision'}})
        raise RuntimeFailure('CPU fixture stop failure')
    monkeypatch.setattr(runtime,'stop',fail)
    with pytest.raises(RuntimeFailure):runtime.drop_warm()
    assert runtime.warm_live()
    assert runtime.memory_status()['retained_model']['state']=='releasing'
    monkeypatch.setattr(runtime,'stop',lambda container:None)
    runtime.drop_warm()
    assert runtime.memory_status()['retained_model'] is None


def test_ordinary_gpt_writing_reuses_server_without_changing_request(tmp_path,monkeypatch):
    """Exercise the real writing orchestration with a CPU-only HTTP fixture."""
    store=Store(tmp_path);project=store.create_project()
    runtime=Runtime(store,{'gptoss_image':'pinned-image'})
    runtime.configure_memory_policy(60)
    active=[None];starts=[];stops=[];bodies=[]
    monkeypatch.setattr('studio.runtime.gpu_status',lambda:{})
    monkeypatch.setattr('studio.runtime.compatibility',lambda *a:{'compatible':True})
    monkeypatch.setattr('studio.release_adapters.prepare_harmony',lambda *a:None)
    monkeypatch.setattr(runtime,'preflight',lambda request:'pinned-image')
    monkeypatch.setattr(runtime,'chat_source',lambda *a:([],{}))
    monkeypatch.setattr(runtime,'wait_ready',lambda *a:None)
    monkeypatch.setattr(runtime,'http',lambda *a,**kw:{'count':100})
    monkeypatch.setattr(runtime,'stop',lambda container:stops.append(container))
    def start(job,*args,**kwargs):
        starts.append(job['id'])
        store.status(job['id'],'loading','CPU fixture',container='owned-fixture')
        return 'owned-fixture',store.root/'jobs'/job['id']
    monkeypatch.setattr(runtime,'start',start)
    def command(args,**kwargs):
        if args[0]=='exec':
            directory=store.root/'jobs'/active[0]
            bodies.append(json.loads((directory/'writing-request.json').read_text())['body'])
            (directory/'writing-result.json').write_text(json.dumps({
                'choices':[{'message':{'content':'CPU test fixture draft.'},'finish_reason':'stop'}]}))
        return subprocess.CompletedProcess(args,0,'','')
    monkeypatch.setattr(runtime,'command',command)
    selected=profile('gptoss-writing','write')
    for seed in (71,72):
        request={'task':'write','profile':selected,'prompt':'Approved notes', 'seed':seed}
        job=store.enqueue(project['id'],request);active[0]=job['id']
        kind,path,metadata=runtime.run(job)
        assert kind=='text' and path.read_text()=='CPU test fixture draft.'
        assert runtime.warm_for(request)
        assert runtime.memory_status()['keep_ready_minutes']==60
        assert store.job(job['id'])['request']==request
    assert len(starts)==1 and not stops
    assert [body['seed'] for body in bodies]==[71,72]
    assert all(body['max_tokens']==selected['max_tokens'] for body in bodies)
    assert not runtime.warm_for({'profile':profile('qwen38-writing','write')})
    assert not runtime.warm_for({'profile':profile('image-standard','image')})


def test_memory_policy_api_persists_applies_and_survives_restart(tmp_path,monkeypatch):
    from fastapi.testclient import TestClient
    from studio.app import create_app
    calls=[]
    configure=Runtime.configure_memory_policy
    def observe(runtime,minutes):
        calls.append(minutes)
        return configure(runtime,minutes)
    monkeypatch.setattr(Runtime,'configure_memory_policy',observe)
    app=create_app(data=tmp_path,config={},worker_enabled=False)
    with TestClient(app) as client:
        token=client.get('/api/session').json()['token']
        initial=client.get('/api/settings').json()
        assert initial['performance']=={'keep_ready_minutes':15}
        body={k:initial[k] for k in ('defaults','appearance','generation','performance')}
        body['generation']['seed']=12345
        body['defaults']['chat']='minicpm5-chat'
        for minutes in (60,15,-1,60,-1):
            body['performance']['keep_ready_minutes']=minutes
            saved=client.put('/api/settings',json=body,headers={'X-Studio-Token':token})
            assert saved.status_code==200
            for values in (saved.json(),client.get('/api/settings').json()):
                assert values['performance']['keep_ready_minutes']==minutes
                assert values['generation']['seed']==12345
                assert values['defaults']['chat']=='minicpm5-chat'
            memory=client.get('/api/status').json()['model_memory']
            assert memory['keep_ready_minutes']==minutes
            assert memory['retained_model'] is None
            assert 'ram_resume_supported' not in memory
    assert calls==[15,60,15,-1,60,-1]
    restarted=create_app(data=tmp_path,config={},worker_enabled=False)
    with TestClient(restarted) as client:
        client.get('/api/session')
        assert client.get('/api/settings').json()['performance']['keep_ready_minutes']==-1
        memory=client.get('/api/status').json()['model_memory']
        assert memory['keep_ready_minutes']==-1 and memory['retained_model'] is None
    assert calls[-1]==-1


@pytest.mark.parametrize('legacy',[2,5])
def test_retired_retention_choices_read_as_the_default(tmp_path,legacy):
    from fastapi.testclient import TestClient
    from studio.app import create_app
    from studio.preferences import get_settings
    store=Store(tmp_path)
    with store.connect() as db:
        db.execute("INSERT INTO preferences VALUES('settings',?)",
                   (json.dumps({'performance':{'keep_ready_minutes':legacy},'generation':{'seed':4242}}),))
    settings=get_settings(store)
    assert settings['performance']['keep_ready_minutes']==15 and settings['generation']['seed']==4242
    app=create_app(data=tmp_path,config={},worker_enabled=False)
    with TestClient(app) as client:
        client.headers['X-Studio-Token']=client.get('/api/session').json()['token']
        assert client.get('/api/settings').json()['performance']['keep_ready_minutes']==15
        assert client.get('/api/status').json()['model_memory']['keep_ready_minutes']==15
        # Retired choices stay migrated on read; they are not accepted as new input.
        assert client.put('/api/settings',json={'performance':{'keep_ready_minutes':legacy}}).status_code==422
        saved=client.put('/api/settings',json={'defaults':{},'appearance':{},'generation':{'seed':4242}})
        assert saved.status_code==200 and saved.json()['performance']['keep_ready_minutes']==15


def test_memory_settings_require_session_token_and_valid_choice(tmp_path):
    from fastapi.testclient import TestClient
    from studio.app import create_app
    app=create_app(data=tmp_path,config={},worker_enabled=False)
    with TestClient(app) as client:
        assert client.get('/api/settings').status_code==401
        body={'performance':{'keep_ready_minutes':60}}
        assert client.put('/api/settings',json=body).status_code==401
        token=client.get('/api/session').json()['token']
        assert client.put('/api/settings',json=body).status_code==403
        assert client.put('/api/settings',json=body,headers={'X-Studio-Token':'wrong'}).status_code==403
        headers={'X-Studio-Token':token}
        for invalid in (0,-2,2,3,5,30,'15',None,True,{},[]):
            response=client.put('/api/settings',json={'performance':{'keep_ready_minutes':invalid}},headers=headers)
            assert response.status_code==422
        assert client.put('/api/settings',json={'performance':{'keep_ready_minutes':60,'arbitrary_cache_path':'/tmp'}},headers=headers).status_code==422
        assert client.put('/api/settings',json={'performance':{'keep_ready_minutes':-1},'defaults':{'image':'gptoss-chat'}},headers=headers).status_code==400
        assert client.get('/api/settings').json()['performance']['keep_ready_minutes']==15
        assert client.get('/api/status').json()['model_memory']['keep_ready_minutes']==15


def test_older_settings_payload_preserves_current_memory_policy(tmp_path):
    from fastapi.testclient import TestClient
    from studio.app import create_app
    app=create_app(tmp_path,config={},worker_enabled=False)
    with TestClient(app) as client:
        client.headers['X-Studio-Token']=client.get('/api/session').json()['token']
        assert client.put('/api/settings',json={'performance':{'keep_ready_minutes':60}}).status_code==200
        # A tab opened before memory settings existed still sends the old groups.
        saved=client.put('/api/settings',json={'defaults':{},'appearance':{},'generation':{'seed':71}})
        assert saved.json()['performance']['keep_ready_minutes']==60
        assert client.get('/api/status').json()['model_memory']['keep_ready_minutes']==60
        assert client.put('/api/settings',json={'performance':{'keep_ready_minutes':-1}}).json()['performance']['keep_ready_minutes']==-1
