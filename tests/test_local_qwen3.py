"""Synthetic package/HTTP fixtures test integration policy, never inference."""
from copy import deepcopy
import hashlib
import json
import os
from subprocess import CompletedProcess

import pytest

from studio import local_qwen3
from studio.chat_adapters import writing_body
from studio.registry import PACKAGES, compatible_profiles, package, profile, validate_snapshot
from studio.runtime import Cancelled, Runtime, RuntimeFailure
from studio.setup_catalog import PACKAGES as SETUP_PACKAGES
from studio.store import Store

FIXTURE_IMAGE = 'sha256:'+'a'*64


@pytest.fixture
def package_fixture(tmp_path, monkeypatch):
    directory=tmp_path/'synthetic-checkpoint';directory.mkdir()
    files=[]
    for name in ('config.json','tokenizer.json','model.safetensors.index.json','model.safetensors'):
        content=('synthetic fixture: '+name).encode()
        (directory/name).write_bytes(content)
        files.append({'file':name,'bytes':len(content),'algorithm':'sha256','digest':hashlib.sha256(content).hexdigest()})
    data={'package':{'status':'hardware-qualified','qualified_tasks':['write'],'qualified_roles':['write'],
        'hardware_evidence':{'synthetic_fixture':True},'model_repository':local_qwen3.REPOSITORY,
        'model_revision':local_qwen3.REVISION,'base_image_id':local_qwen3.BASE_IMAGE_ID,
        'architecture':'PaitonDenseQwen3ForCausalLM','max_context_length':8192,
        'max_batched_tokens':128,'max_batch_size':1,'physical_cache_blocks':513,'reserved_cache_blocks':1},
        'checkpoint':{'repository':local_qwen3.REPOSITORY,'revision':local_qwen3.REVISION,'files':files}}
    monkeypatch.setattr(local_qwen3,'QUALIFIED_IMAGE_ID',FIXTURE_IMAGE)
    calls=[]
    def command(args,**kwargs):
        calls.append(args)
        if args[0]=='inspect':
            return CompletedProcess(args,1,'','Error: No such object')
        body=[{'Id':FIXTURE_IMAGE}] if args[:2]==['image','inspect'] else data
        return CompletedProcess(args,0,json.dumps(body),'')
    return directory,data,command,calls


@pytest.fixture
def active_fixture(monkeypatch):
    """Enable only a synthetic policy fixture; production stays integrated=False."""
    model=next(item for item in PACKAGES if item['id']=='qwen3-4b')
    monkeypatch.setitem(model,'integrated',True)
    monkeypatch.setitem(model,'hardware',{'supported_architectures':['gfx1201'],
        'required_device_names':['AMD Radeon AI PRO R9700'],
        'required_vram_gib':8,'minimum_reported_vram_gib':8,
        'qualification':'Synthetic CPU fixture, not hardware qualification.'})
    return profile('qwen3-4b-short','write')


def test_candidate_is_disabled_and_has_only_a_manual_short_draft_contract():
    candidate=package('qwen3-4b')
    assert candidate['integrated'] is False and candidate['default_for']==[]
    assert candidate['capabilities']==['text.generate']
    assert candidate['profiles'][0]['roles']==['write']
    assert candidate['profiles'][0]['context']==8192 and candidate['profiles'][0]['max_tokens']==512
    assert candidate['quality_note'] and candidate['profiles'][0]['quality_note']
    assert 'failed factual writing' in candidate['quality_note']
    for role in ('write','website','video','image'):
        assert all(item['package']!='qwen3-4b' for item in compatible_profiles(role))
    assert SETUP_PACKAGES['qwen3-4b']['can_install'] is False
    assert SETUP_PACKAGES['qwen3-4b']['installer']=='manual'
    assert SETUP_PACKAGES['qwen3-4b']['image'] is None
    assert 'failed factual writing' in SETUP_PACKAGES['qwen3-4b']['message']


def test_consumer_tools_omit_unreleased_candidates_but_keep_incompatible_installed_models(tmp_path,monkeypatch):
    from fastapi.testclient import TestClient
    from studio.app import create_app
    monkeypatch.setattr(Runtime,'preflight',lambda *args:'synthetic-installed-image')
    monkeypatch.setattr('studio.app.gpu_status',lambda:dict(driver_available=True,supported=True,
        gpu_count=1,name='AMD Radeon RX 9070 XT',architecture='gfx1201',total=16*1024**3))
    monkeypatch.setattr('studio.setup.SetupManager._system',lambda *args:pytest.fail('Rejected packages must not probe the host'))
    with TestClient(create_app(tmp_path,config={},worker_enabled=False)) as client:
        client.headers['X-Studio-Token']=client.get('/api/session').json()['token']
        response=client.get('/api/tools')
        rejected=client.post('/api/setup/qwen3-4b/install')
    assert response.status_code==200
    tools=response.json()
    assert {item['id'] for item in tools}=={'minicpm5-2b','flux','h3','qwen-coder','qwen38','qwen38-mxfp4','gptoss','wan','fastwan'}
    assert all(item['integrated'] and item['installed'] and item['state']=='incompatible' for item in tools)
    assert rejected.status_code==400
    assert rejected.json()['error']=='Choose a supported local model package.'


def test_write_only_role_and_token_limit_remain_fixed(active_fixture):
    body=writing_body({'profile':active_fixture,'prompt':'A supplied fact.','seed':42})
    assert body['model']=='paiton-qwen3-4b' and body['max_tokens']==512 and body['seed']==42
    assert 'chat_template_kwargs' not in body
    assert {item['id'] for item in compatible_profiles('write')} >= {'qwen3-4b-short'}
    assert all(item['package']!='qwen3-4b' for item in compatible_profiles('website'))
    with pytest.raises(ValueError):profile('qwen3-4b-short','write','website')
    with pytest.raises(ValueError):writing_body({'profile':active_fixture,'messages':[{'role':'user','content':'Plan a site'}]})
    with pytest.raises(ValueError):validate_snapshot({**active_fixture,'max_tokens':2048},'write')
    assert validate_snapshot({**active_fixture,'quality_note':'An earlier display note.'},'write')['max_tokens']==512


def test_hashing_is_cached_for_status_and_execution_but_invalidates_on_mutation(package_fixture,tmp_path,monkeypatch,active_fixture):
    directory,data,command,calls=package_fixture
    runtime=Runtime(Store(tmp_path/'store'),{'qwen3_4b_image':FIXTURE_IMAGE,'qwen3_4b_model_dir':str(directory)})
    runtime.command=command
    hashes=[];original=local_qwen3.file_digest
    def counted(path,algorithm):hashes.append(path.name);return original(path,algorithm)
    monkeypatch.setattr(local_qwen3,'file_digest',counted)
    assert runtime.preflight({'profile':active_fixture})==FIXTURE_IMAGE
    first=len(hashes)
    assert first==len(data['checkpoint']['files'])
    assert runtime.preflight({'task':'write','profile':active_fixture})==FIXTURE_IMAGE
    assert len(hashes)==first
    probes=[args for args in calls if args[0]=='run']
    assert len(probes)==1 and '--device' not in probes[0]
    assert probes[0][probes[0].index('--network')+1]=='none'
    assert '--read-only' in probes[0] and '--pull=never' in probes[0]
    assert 'installed_check' in probes[0][-1]
    weight=directory/'model.safetensors';before=weight.stat()
    weight.write_bytes(b'x'*before.st_size)
    os.utime(weight,ns=(before.st_atime_ns,before.st_mtime_ns))
    with pytest.raises(RuntimeFailure,match='hash differs'):
        runtime.preflight({'profile':active_fixture})
    changed=len(hashes);assert changed>first
    with pytest.raises(RuntimeFailure,match='hash differs'):
        runtime.preflight({'profile':active_fixture})
    assert len(hashes)==changed  # Unchanged corrupt files are not rehashed by polling.


@pytest.mark.parametrize('change',[{'status':'qualification-in-progress'}, {'qualified_roles':['website']},
    {'qualified_tasks':['video']},{'hardware_evidence':None},{'physical_cache_blocks':512}])
def test_unqualified_or_wrong_role_packages_fail_before_checkpoint_hashing(package_fixture,change,monkeypatch):
    directory,data,command,_=package_fixture;data['package'].update(change)
    monkeypatch.setattr(local_qwen3,'file_digest',lambda *args:pytest.fail('Invalid package must fail before reading checkpoint bytes'))
    with pytest.raises(local_qwen3.LocalPackageError,match='qualified short-draft'):
        local_qwen3.LocalQwen3Validator().validate(command,'synthetic-owner',FIXTURE_IMAGE,directory,
            local_qwen3.REVISION,json.dumps([{'Id':FIXTURE_IMAGE}]))


def test_pending_image_tags_and_image_substitution_are_not_accepted(package_fixture,monkeypatch):
    directory,_,command,_=package_fixture
    validator=local_qwen3.LocalQwen3Validator()
    for image in ('local-model:latest','sha256:'+'b'*64):
        with pytest.raises(local_qwen3.LocalPackageError,match='not been qualified'):
            validator.validate(command,'owner',image,directory,local_qwen3.REVISION,'[]')
    with pytest.raises(local_qwen3.LocalPackageError,match='immutable image ID'):
        validator.validate(command,'owner',FIXTURE_IMAGE,directory,local_qwen3.REVISION,json.dumps([{'Id':'other'}]))
    monkeypatch.setattr(local_qwen3,'QUALIFIED_IMAGE_ID',None)
    with pytest.raises(local_qwen3.LocalPackageError,match='not been qualified'):
        validator.validate(command,'owner',FIXTURE_IMAGE,directory,local_qwen3.REVISION,'[]')


@pytest.mark.parametrize('same_owner',[True,False])
def test_metadata_timeout_removes_only_the_exact_owned_probe(package_fixture,same_owner):
    directory,_,_,_=package_fixture
    state={};calls=[];identity='c'*64
    def command(args,**kwargs):
        calls.append(args)
        if args[0]=='run':
            state['name']=args[args.index('--name')+1]
            state['labels']=dict(value.split('=',1) for i,value in enumerate(args) if i and args[i-1]=='--label')
            raise RuntimeFailure('Synthetic Docker client timeout')
        if args[0]=='inspect':
            labels={**state['labels']}
            if not same_owner:labels['dev.paiton.studio.probe']='a different task'
            return CompletedProcess(args,0,json.dumps([{'Name':'/'+state['name'],'Id':identity,'Config':{'Labels':labels}}]),'')
        assert args==['rm','--force',identity] and same_owner
        return CompletedProcess(args,0,identity,'')
    expected=RuntimeFailure if same_owner else local_qwen3.LocalPackageError
    message='client timeout' if same_owner else 'ownership could not be verified'
    with pytest.raises(expected,match=message):
        local_qwen3.LocalQwen3Validator().validate(command,'owner',FIXTURE_IMAGE,directory,
            local_qwen3.REVISION,json.dumps([{'Id':FIXTURE_IMAGE}]))
    assert any(args[0]=='rm' for args in calls) is same_owner
    assert state['name'].startswith('paiton-studio-package-check-')


def test_direct_checkpoint_contract_never_uses_qwen38_cache_keys(tmp_path):
    directory=tmp_path/'checkpoint';directory.mkdir()
    runtime=Runtime(Store(tmp_path/'data'),{'qwen3_4b_model_dir':str(directory),
        'qwen38_cache_volume':'different-model-cache','hf_hub_dir':'/unrelated/hub'})
    assert runtime.chat_source('qwen3-4b',local_qwen3.REVISION)==([(str(directory),'/models/checkpoint')],{})
    runtime.config.pop('qwen3_4b_model_dir')
    with pytest.raises(RuntimeFailure):runtime.chat_source('qwen3-4b',local_qwen3.REVISION)


@pytest.mark.parametrize('cancel',[False,True])
def test_short_draft_reuses_owned_chat_http_and_cancellation(tmp_path,monkeypatch,active_fixture,cancel):
    monkeypatch.setattr('studio.runtime.gpu_status',lambda:{'driver_available':True,'gpu_count':1,
        'name':'AMD Radeon AI PRO R9700','architecture':'gfx1201','total':32*1024**3})
    checkpoint=tmp_path/'checkpoint';checkpoint.mkdir()
    store=Store(tmp_path/'data');project=store.create_project()
    job=store.enqueue(project['id'],{'task':'write','profile':active_fixture,'prompt':'A supplied fact.'})
    runtime=Runtime(store,{'qwen3_4b_model_dir':str(checkpoint)});runtime.preflight=lambda _:FIXTURE_IMAGE
    starts=[];stopped=[]
    def start(job,image,args,**kwargs):
        starts.append((image,args,kwargs));return 'synthetic-owned-container',store.root/'jobs'/job['id']
    runtime.start=start;runtime.stop=stopped.append
    runtime.wait_ready=lambda job,container,port,path:None
    runtime.http=lambda *args,**kwargs:{'count':100}
    def command(args,**kwargs):
        if args[0]=='exec':
            if cancel:
                with store.connect() as db:db.execute('UPDATE jobs SET cancel=1 WHERE id=?',(job['id'],))
            else:
                (store.root/'jobs'/job['id']/'writing-result.json').write_text(json.dumps({'choices':[{'message':{'content':'Synthetic fixture output.'},'finish_reason':'stop'}]}))
        return CompletedProcess(args,0,'','')
    runtime.command=command
    if cancel:
        with pytest.raises(Cancelled):runtime.run(job)
    else:
        kind,path,_=runtime.run(job);assert kind=='text' and path.read_text()=='Synthetic fixture output.'
    assert starts[0][1]==[] and starts[0][2]['mounts']==[(str(checkpoint),'/models/checkpoint')]
    body=json.loads((store.root/'jobs'/job['id']/'writing-request.json').read_text())
    assert body['port']==8020 and body['body']['max_tokens']==512
    assert stopped==['synthetic-owned-container']
