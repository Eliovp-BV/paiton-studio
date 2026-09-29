"""CPU launch contracts; fake responses are not GPU qualification."""
from copy import deepcopy
import json
import os
from pathlib import Path
from subprocess import CompletedProcess
from types import SimpleNamespace

import pytest

from studio import qwen_mxfp4 as checkpoints
from studio.chat_adapters import writing_body
from studio.conversation_options import ConversationOptions, RELEASE, apply_options, details, engine_profile, image_for
from studio.registry import profile, validate_snapshot
from studio.runtime import Runtime, RuntimeFailure
from studio.store import Store
from test_qwen_reuse import qwen_runtime


def selected(weights='mxfp4', mode='long', reuse=False):
    return apply_options(profile('qwen38-mxfp4-writing','write'),
                         {'weights':weights,'context_mode':mode,'reuse_cache':reuse})


def config(tmp_path):
    result={'qwen38_mxfp4_image':checkpoints.IMAGE}
    for role,key in [('target','qwen38_nvfp4_target_dir'),('legacy','qwen38_mxfp4_target_dir'),
                     ('draft','qwen38_mxfp4_draft_dir'),('w3','qwen38_w3rot_dir')]:
        directory=tmp_path/role;directory.mkdir(exist_ok=True)
        result[key]=str(directory)
    return result


@pytest.mark.parametrize('weights',['mxfp4','w3a4'])
@pytest.mark.parametrize('mode,reuse',[('short',False),('long',False),('long',True),('extra_long',False)])
def test_runtime_variants_keep_exact_release_choices(tmp_path,weights,mode,reuse):
    runtime=Runtime(Store(tmp_path/'data'),config(tmp_path))
    request={'profile':selected(weights,mode,reuse)}
    resolved=runtime._qwen_execution(request)
    args=resolved['engine']['arguments']; env=resolved['env']
    chat=reuse or mode=='extra_long'
    assert args[:2]==['serve',str('/models/target')]
    assert args[args.index('--port')+1]=='18982'
    assert args[args.index('--served-model-name')+1]=='Qwen3.8'
    assert args[args.index('--attention-backend')+1]=='R4D'
    assert args[args.index('--tool-call-parser')+1]=='qwen3_coder'
    assert args[args.index('--mamba-cache-mode')+1]=='align'
    assert args[args.index('--max-num-batched-tokens')+1]==('1024' if chat else '4096')
    assert args[args.index('--kv-cache-memory-bytes')+1]==str(8589934592 if chat else (8859648000 if weights=='w3a4' else 6535819798))
    assert not any(flag in args for flag in ['--offline','--target','--draft','--worker-cls','--load-format'])
    assert all(env[flag]==('1' if weights=='w3a4' else '0') for flag in ['PAITON_W3_A4','PAITON_W3_DECODE','PAITON_W3_PREFILL'])
    assert all(env[flag]==('1' if weights=='w3a4' and not chat else '0') for flag in ['PAITON_KV4','PAITON_KV4_CAPACITY'])
    assert not any(key.startswith('PAITON_EXPERIMENTAL_GDN_') for key in env)
    assert resolved['conversation']['aggregate_kv_tokens']==(393216 if weights=='w3a4' and not chat else None)
    assert resolved['conversation']['context']=={'short':8192,'long':65536,'extra_long':200000}[mode]
    assert resolved['conversation']['prefix_caching']==chat
    assert resolved['conversation']['kv_cache_mode']==('kv4' if weights=='w3a4' and not chat else 'fp8')
    assert resolved['conversation']['vision'] is False and '--language-model-only' in args
    assert resolved['cache']['cache_target']=='/cache'
    assert env['AITER_ROOT_DIR']=='/cache/aiter' and env['VLLM_CACHE_ROOT']=='/cache/vllm'
    if weights=='w3a4':
        assert env['PAITON_W3ROT_DIR']==env['PAITON_W3_A4_DIR']=='/models/w3rot'
        assert (str(tmp_path/'w3'),'/models/w3rot') in resolved['sources']['mounts']
    else:
        assert all(destination!='/models/w3rot' for _,destination in resolved['sources']['mounts'])
        assert 'PAITON_W3ROT_DIR' not in env
    assert writing_body({**request,'prompt':'Fixture','runtime_ref':resolved['reference']})['model']=='Qwen3.8'
    assert str(tmp_path) not in json.dumps(resolved['receipt'])


def test_legacy_image_and_options_snapshots_keep_their_identity(tmp_path):
    runtime=Runtime(Store(tmp_path/'data'),config(tmp_path))
    snapshot=selected();snapshot['conversation_options'].pop('weights')
    restored=validate_snapshot(snapshot)
    assert restored['conversation_options']['weights']=='mxfp4'
    old=RELEASE['legacy_images']['64k']['registry_image']
    request={'profile':restored,'runtime_image':old.rsplit('@',1)[-1],'runtime_ref':old}
    resolved=runtime._qwen_execution(request)
    assert resolved['reference']==old
    assert resolved['conversation']['context']==65536
    assert resolved['conversation']['tool_parser']=='qwen3_xml'
    assert resolved['conversation']['kv_cache_bytes']==5368709120
    assert resolved['sources']['components']['target']['spec']['repository']=='amd/Qwen3.8-27B-Quark-AWQ-MXFP4'
    assert writing_body({**request,'prompt':'Fixture'})['model']=='Qwen3.8-27B-Quark-AWQ-MXFP4'
    forged=deepcopy(snapshot);forged['conversation_options']['hidden_override']=1
    with pytest.raises(ValueError):validate_snapshot(forged)
    assert ConversationOptions(context_mode='extra_long',weights='w3a4').weights=='w3a4'
    with pytest.raises(ValueError):engine_profile({'context_mode':'extra_long','weights':'w3a4'},checkpoints.LEGACY_200K_IMAGE)
    extra=runtime._qwen_execution({'profile':selected(mode='extra_long')})
    assert extra['reference']==RELEASE['images']['200k']['registry_image']
    assert extra['conversation']['context']==200000 and extra['conversation']['kv_cache_bytes']==8589934592
    assert extra['cache']['cache_target']=='/cache'


def test_warm_identity_tracks_weights_release_and_selected_sources(tmp_path):
    runtime=Runtime(Store(tmp_path/'data'),config(tmp_path))
    mxfp4={'profile':selected()};w3a4={'profile':selected('w3a4')}
    mx=runtime._qwen_execution(mxfp4);w3=runtime._qwen_execution(w3a4)
    assert mx['identity']!=w3['identity']
    runtime._remember_warm(mxfp4,checkpoints.IMAGE,'fixture-container',execution=mx)
    assert runtime.warm_for(mxfp4)
    assert not runtime.warm_for(w3a4)
    assert not runtime.warm_for({'profile':selected(mode='extra_long')})
    alternate=tmp_path/'other-target';alternate.mkdir()
    runtime.config['qwen38_nvfp4_target_dir']=str(alternate)
    assert not runtime.warm_for(mxfp4)


@pytest.mark.parametrize('weights',['mxfp4','w3a4'])
@pytest.mark.parametrize('reuse',[False,True])
def test_previous_rocm10_snapshot_keeps_fp8_budget_and_isolated_cache(tmp_path,weights,reuse):
    runtime=Runtime(Store(tmp_path/'data'),config(tmp_path))
    previous=RELEASE['previous_images']['64k']['registry_image']
    request={'profile':selected(weights,reuse=reuse),'runtime_image':previous.rsplit('@',1)[-1],
             'runtime_ref':previous}
    old=runtime._qwen_execution(request)
    current=runtime._qwen_execution({'profile':request['profile']})
    expected=8589934592 if reuse else (9381235631 if weights=='w3a4' else 6535819798)
    assert old['conversation']['kv_cache_bytes']==expected
    assert old['conversation']['kv_cache_mode']=='fp8'
    assert old['conversation']['aggregate_kv_tokens']==(250578 if weights=='w3a4' and not reuse else None)
    assert 'PAITON_KV4' not in old['env'] and 'PAITON_KV4_CAPACITY' not in old['env']
    assert old['cache']!=current['cache'] and old['identity']!=current['identity']
    runtime._remember_warm(request,request['runtime_image'],'fixture-container',execution=old)
    assert runtime.warm_for(request)
    assert not runtime.warm_for({'profile':request['profile']})
    with pytest.raises(ValueError,match='context'):
        runtime._qwen_execution({'profile':selected(weights,mode='extra_long'),'runtime_image':request['runtime_image']})


def test_text_only_contract_rejects_vision_input_and_tracks_visibility_masks(tmp_path,monkeypatch):
    runtime=Runtime(Store(tmp_path/'data'),config(tmp_path))
    request={'profile':selected('w3a4')}
    monkeypatch.delenv('ROCR_VISIBLE_DEVICES',raising=False)
    first=runtime._qwen_execution(request)
    monkeypatch.setenv('ROCR_VISIBLE_DEVICES','1')
    assert runtime._qwen_execution(request)['identity']!=first['identity']
    assert not any('vision' in capability or 'image' in capability for capability in request['profile']['capabilities'])
    chat=apply_options(profile('qwen38-mxfp4-chat','write'),{'weights':'w3a4'})
    with pytest.raises(ValueError,match='messages'):
        writing_body({'profile':chat,'messages':[{'role':'user','content':[
            {'type':'text','text':'Describe this image'},
            {'type':'image_url','image_url':{'url':'data:image/png;base64,fixture'}}]}]})


def test_writable_cache_and_readonly_sources_use_fake_docker_only(tmp_path,monkeypatch):
    runtime=Runtime(Store(tmp_path/'data'),config(tmp_path))
    project=runtime.store.create_project()['id']
    request={'task':'write','profile':selected('w3a4'),'prompt':'Fixture'}
    job=runtime.store.enqueue(project,request)
    monkeypatch.setenv('ROCR_VISIBLE_DEVICES','1')
    monkeypatch.setenv('HIP_VISIBLE_DEVICES','')
    monkeypatch.delenv('CUDA_VISIBLE_DEVICES',raising=False)
    resolved=runtime._qwen_execution(request)
    real_stat=os.stat
    monkeypatch.setattr('studio.runtime.os.stat',lambda path,*a,**kw:SimpleNamespace(st_gid=1234) if str(path)=='/dev/kfd' else real_stat(path,*a,**kw))
    commands=[]
    def command(args,**kwargs):
        commands.append(args)
        return CompletedProcess(args,0,'owned-fixture-container','')
    monkeypatch.setattr(runtime,'command',command)
    runtime.start(job,checkpoints.IMAGE,resolved['engine']['arguments'],env=resolved['env'],mounts=resolved['sources']['mounts'],**resolved['cache'])
    command=commands[0]
    volumes=[command[i+1] for i,value in enumerate(command[:-1]) if value=='-v']
    assert any(value.endswith(':/cache:rw') and '/runtime-cache/qwen38-mxfp4/rocm10-' in value for value in volumes)
    assert all(str(tmp_path/name)+':/models/'+mount+':ro' in volumes for name,mount in [('target','target'),('draft','draft'),('w3','w3rot')])
    assert not any('engine-profile.json' in value or value.endswith(':/models/cache') for value in volumes)
    assert command[command.index('--network')+1]=='none'
    assert command[command.index('--cap-drop')+1]=='ALL'
    assert '--entrypoint' not in command
    environment=[command[i+1] for i,value in enumerate(command[:-1]) if value=='-e']
    assert 'ROCR_VISIBLE_DEVICES=1' in environment and 'HIP_VISIBLE_DEVICES=' in environment
    assert 'CUDA_VISIBLE_DEVICES' in environment and 'CUDA_VISIBLE_DEVICES=' not in environment


def test_switching_weights_restarts_then_reuses_with_saved_reply_metadata(qwen_runtime,tmp_path):
    state=qwen_runtime
    state.runtime.config.update(config(tmp_path))
    state.runtime.preflight=lambda request:image_for(request['profile'])
    ports=[]
    def http(container,port,path,body,**kwargs):
        ports.append(port)
        assert path=='/tokenize' and port==18982
        state.tokenized.append(deepcopy(body));return {'count':100}
    state.runtime.http=http
    project=state.store.create_project()['id']
    assets=[]
    for weights in ['mxfp4','w3a4','w3a4','mxfp4']:
        request={'task':'write','profile':selected(weights),'prompt':'Fixture '+weights,'seed':1}
        job=state.store.enqueue(project,request);state.worker._run_job(job)
        complete=state.store.job(job['id'])
        assert complete['state']=='completed',complete
        asset=state.store.asset(complete['asset']);assets.append(asset)
        assert asset['metadata']['conversation']['weights']==weights
        assert asset['metadata']['runtime_contract']['weights']==weights
        assert asset['metadata']['runtime_contract']['runtime_image']==checkpoints.IMAGE
    assert len(state.starts)==3 and len(state.stops)==2
    assert ports==[18982]*4
    assert all(body['model']=='Qwen3.8' for _,body in state.bodies)
    assert [asset['metadata']['performance']['model_state'] for asset in assets]==['cold','cold','warm','cold']


def test_preflight_resolves_classic_docker_ids_and_verifies_selected_weights(tmp_path,monkeypatch):
    runtime=Runtime(Store(tmp_path/'data'),config(tmp_path))
    image_id='sha256:'+'f'*64
    inspected=json.dumps([{'Id':image_id,'RepoDigests':[checkpoints.IMAGE]}])
    monkeypatch.setattr(runtime,'command',lambda args,**kwargs:CompletedProcess(args,0,inspected,''))
    verified=[]
    monkeypatch.setattr(checkpoints,'preflight',lambda runtime,image,inspection,weights='mxfp4',**kwargs:verified.append((image,weights)))
    for weights in ['mxfp4','w3a4']:
        request={'profile':selected(weights),'runtime_image':image_id}
        assert runtime.preflight(request)==image_id
        assert runtime._qwen_execution(request)['reference']==checkpoints.IMAGE
    assert verified==[(image_id,'mxfp4'),(image_id,'w3a4')]
    extra={'profile':selected('w3a4',mode='extra_long'),'runtime_image':image_id}
    assert runtime._qwen_execution(extra)['reference']==checkpoints.IMAGE


@pytest.mark.parametrize('mode,reference,weights,legacy',[
    ('long',checkpoints.LEGACY_64K_IMAGE,'mxfp4',True),
    ('extra_long',checkpoints.LEGACY_200K_IMAGE,'mxfp4',True),
    ('long',RELEASE['previous_images']['64k']['registry_image'],'mxfp4',False),
    ('long',RELEASE['previous_images']['64k']['registry_image'],'w3a4',False),
])
def test_queued_previous_snapshots_keep_saved_target_launcher_and_receipt(qwen_runtime,tmp_path,monkeypatch,mode,reference,weights,legacy):
    state=qwen_runtime
    state.runtime.config.update(config(tmp_path))
    if legacy:
        state.runtime.config.pop('qwen38_nvfp4_target_dir')
        state.runtime.config.pop('qwen38_w3rot_dir')
    image_id='sha256:'+'e'*64
    inspection=json.dumps([{'Id':image_id,'RepoDigests':[reference]}])
    command=state.runtime.command
    monkeypatch.setattr(state.runtime,'command',lambda args,**kwargs:
                        CompletedProcess(args,0,inspection,'') if args[:2]==['image','inspect'] else command(args,**kwargs))
    # Only checkpoint hashing is replaced; real image-family and runtime
    # preflight choose the legacy sources and execution contract.
    checked=[]
    monkeypatch.setattr(checkpoints,'preflight',lambda runtime,image,inspected,weights='mxfp4',**kwargs:
                        checked.append(checkpoints.source_contract(runtime.config,reference,weights)))
    monkeypatch.setattr(state.runtime,'preflight',lambda request:Runtime.preflight(state.runtime,request))
    if not legacy:
        def http(container,port,path,body,**kwargs):
            assert port==18982 and path=='/tokenize'
            state.tokenized.append(deepcopy(body));return {'count':100}
        monkeypatch.setattr(state.runtime,'http',http)
    snapshot=selected(weights,mode=mode)
    if legacy:snapshot['conversation_options'].pop('weights')
    request={'task':'write','profile':snapshot,'runtime_image':image_id,'runtime_ref':reference,
             'prompt':'Saved before the upgrade','seed':1}
    project=state.store.create_project()['id']
    for expected in ['cold','warm']:
        job=state.store.enqueue(project,deepcopy(request));state.worker._run_job(job)
        saved=state.store.job(job['id'])
        assert saved['state']=='completed',saved
        assert saved['request']==request
        metadata=state.store.asset(saved['asset'])['metadata']
        assert metadata['performance']['model_state']==expected
        assert metadata['conversation']['weights']==weights
        assert metadata['conversation']['kv_cache_mode']=='fp8'
        assert metadata['conversation']['runtime_image']==reference
        assert metadata['conversation']['context']==(200000 if mode=='extra_long' else 65536)
        assert metadata['runtime_contract']['components']['target']['repository']==('amd/Qwen3.8-27B-Quark-AWQ-MXFP4' if legacy else 'unsloth/Qwen3.8-27B-NVFP4')
    assert len(state.starts)==1 and not state.stops
    _,actual_image,args,kwargs=state.starts[0]
    assert actual_image==image_id
    if legacy:
        assert args==['--offline','--target','/models/target','--draft','/models/draft']
        assert 'cache_variant' not in kwargs and 'cache_target' not in kwargs
        profile_mount=next(source for source,destination in kwargs['mounts'] if destination=='/opt/paiton-release/engine-profile.json')
        launch=json.loads(Path(profile_mount).read_text())
        assert launch['arguments'][launch['arguments'].index('--port')+1]=='8000'
        assert '--worker-cls' in launch['arguments']
    else:
        assert args[:2]==['serve','/models/target'] and args[args.index('--port')+1]=='18982'
        assert args[args.index('--kv-cache-memory-bytes')+1]==str(9381235631 if weights=='w3a4' else 6535819798)
        assert not any(destination=='/opt/paiton-release/engine-profile.json' for _,destination in kwargs['mounts'])
        assert 'PAITON_KV4' not in kwargs['env'] and 'PAITON_KV4_CAPACITY' not in kwargs['env']
    assert all(body['model']==('Qwen3.8-27B-Quark-AWQ-MXFP4' if legacy else 'Qwen3.8') for _,body in state.bodies)
    assert checked and all(source['legacy']==legacy for source in checked)


@pytest.mark.parametrize('mode',['long','extra_long'])
def test_enqueue_pins_classic_image_id_and_reuses_resolved_w3_server(qwen_runtime,tmp_path,monkeypatch,mode):
    state=qwen_runtime
    state.runtime.config.update(config(tmp_path))
    image_id='sha256:'+'d'*64
    inspection=json.dumps([{'Id':image_id,'RepoDigests':[checkpoints.IMAGE]}])
    command=state.runtime.command
    monkeypatch.setattr(state.runtime,'command',lambda args,**kwargs:
                        CompletedProcess(args,0,inspection,'') if args[:2]==['image','inspect'] else command(args,**kwargs))
    monkeypatch.setattr(checkpoints,'preflight',lambda *args,**kwargs:None)
    monkeypatch.setattr(state.runtime,'preflight',lambda request:Runtime.preflight(state.runtime,request))
    state.store.prepare_request=state.runtime.pin_request
    def http(container,port,path,body,**kwargs):
        assert port==18982 and path=='/tokenize'
        state.tokenized.append(deepcopy(body));return {'count':100}
    monkeypatch.setattr(state.runtime,'http',http)
    project=state.store.create_project()['id']
    for expected in ['cold','warm']:
        job=state.store.enqueue(project,{'task':'write','profile':selected('w3a4',mode),'prompt':'Fixture','seed':1})
        assert job['request']['runtime_image']==image_id
        assert job['request']['runtime_ref']==checkpoints.IMAGE
        state.worker._run_job(job)
        saved=state.store.job(job['id'])
        assert saved['state']=='completed',saved
        metadata=state.store.asset(saved['asset'])['metadata']
        assert metadata['performance']['model_state']==expected
        assert metadata['runtime_contract']['runtime_image']==checkpoints.IMAGE
        assert metadata['runtime_contract']['weights']=='w3a4'
    assert len(state.starts)==1 and not state.stops
    assert state.starts[0][1]==image_id


def test_readiness_inspection_cannot_disable_request_content_verification(tmp_path,monkeypatch):
    runtime=Runtime(Store(tmp_path/'data'),config(tmp_path))
    inspected=json.dumps([{'Id':checkpoints.IMAGE_ID,'RepoDigests':[checkpoints.IMAGE]}])
    monkeypatch.setattr(runtime,'command',lambda args,**kwargs:CompletedProcess(args,0,inspected,''))
    calls=[]
    def verify(runtime,image,inspection,weights='mxfp4',*,verify_content=True):
        calls.append((weights,verify_content))
        if verify_content:
            raise ValueError('Fixture checkpoint checksum mismatch')
    monkeypatch.setattr(checkpoints,'preflight',verify)
    request={'profile':selected('w3a4'),'prompt':'Fixture'}
    assert runtime.preflight(request,verify_content=False)==checkpoints.IMAGE
    for fields in ({},{'verify_content':False},{'verify_content':False,'metadata_only':True}):
        with pytest.raises(RuntimeFailure,match='checksum mismatch'):
            runtime.preflight({**request,**fields})
    assert calls==[('w3a4',False),('w3a4',True),('w3a4',True),('w3a4',True)]


def test_metadata_flag_does_not_change_other_package_preflight(tmp_path,monkeypatch):
    runtime=Runtime(Store(tmp_path/'data'),{'minicpm5_image':'fixture-minicpm'})
    monkeypatch.setattr(runtime,'command',lambda args,**kwargs:CompletedProcess(args,0,'fixture inspection',''))
    calls=[]
    # This existing adapter deliberately accepts no verification keyword.
    monkeypatch.setattr('studio.release_adapters.preflight',lambda runtime,selected,inspection:
                        calls.append((selected['package'],inspection)))
    assert runtime.preflight({'profile':profile('minicpm5-chat','write')},verify_content=False)=='fixture-minicpm'
    assert calls==[('minicpm5-2b','fixture inspection')]
