"""No-network/no-GPU tests of pinned setup and public vocabulary preparation."""
import hashlib,json,os,subprocess
from pathlib import Path
import pytest
from studio.setup_alternatives import snapshot,gptoss,GPT_REVISION
from studio.release_adapters import prepare_harmony
from studio.runtime import Runtime
from studio.store import Store

class Manager:
    def __init__(self,root,data):self.root=root;self.data=data;self.downloads=[];self.updates=[]
    def read_json(self,*args,**kwargs):return self.data
    def update(self,*args,**kwargs):self.updates.append((args,kwargs))
    def download(self,url,dest,size,digest,job):self.downloads.append((url,dest,size,digest))

def test_snapshot_requires_revision_and_integrity(tmp_path):
    m=Manager(tmp_path,{'sha':'a'*40,'siblings':[{'rfilename':'models/weight.bin','lfs':{'size':100,'sha256':'b'*64}}]})
    snapshot(m,{},'owner/model','a'*40,tmp_path,['models/*'])
    assert m.downloads[0][1]==tmp_path/'models/weight.bin'
    assert '/resolve/'+('a'*40)+'/' in m.downloads[0][0]
    m.data['sha']='changed'
    with pytest.raises(ValueError,match='revision'):snapshot(m,{},'owner/model','a'*40,tmp_path,['*'])
    m.data['sha']='a'*40;m.data['siblings'][0]={'rfilename':'weights.bin','size':100}
    with pytest.raises(ValueError,match='integrity'):snapshot(m,{},'owner/model','a'*40,tmp_path,['*'])

def test_snapshot_rejects_path_escape(tmp_path):
    m=Manager(tmp_path,{'sha':'a'*40,'siblings':[{'rfilename':'../escape','size':1,'blobId':'b'*40}]})
    with pytest.raises(ValueError):snapshot(m,{},'owner/model','a'*40,tmp_path,['*'])
    assert not m.downloads

def test_gpt_setup_only_connects_after_file_verification(tmp_path,monkeypatch):
    import studio.setup_alternatives as module
    m=Manager(tmp_path,{});calls=[]
    m.run=lambda argv,job:calls.append(argv)
    m.configure=lambda *args:calls.append('configured')
    monkeypatch.setattr(module,'snapshot',lambda *args:None)
    with pytest.raises(ValueError,match='missing'):gptoss(m,{'id':'fixture'})
    assert calls[0][:2]==['docker','pull'] and 'configured' not in calls

def test_vocab_extraction_has_no_gpu_network_or_model_execution(tmp_path):
    store=Store(tmp_path);p=store.create_project();job=store.enqueue(p['id'],{'task':'write'})
    runtime=Runtime(store,{});calls=[];stopped=[]
    def command(args,**kw):
        calls.append(args)
        return subprocess.CompletedProcess(args,0,'owned-vocab-id' if args[0]=='create' else 'wrong vocabulary','')
    runtime.command=command;runtime.stop=lambda c:stopped.append(c)
    with pytest.raises(ValueError,match='checksum'):prepare_harmony(runtime,job,'pinned-image')
    create=calls[0]
    assert '--device' not in create and create[create.index('--network')+1]=='none'
    assert create[create.index('--entrypoint')+1]=='cat'
    assert create[create.index('--cap-drop')+1]=='ALL' and create[create.index('--security-opt')+1]=='no-new-privileges'
    assert stopped==['owned-vocab-id']
    assert not list((tmp_path/'runtime-cache/gptoss/harmony').iterdir())

def test_fastwan_conversion_container_is_unprivileged_and_cpu_only(tmp_path,monkeypatch):
    import studio.setup_alternatives as module
    from studio.setup_media import SETUP_OWNER_LABEL,SETUP_LABEL
    (tmp_path/'owner').write_text('studio-test-owner')
    m=Manager(tmp_path,{});calls=[];job={'id':'fixture','package':'fastwan'}
    def snapshot(manager,current,repo,revision,directory,patterns):
        directory=Path(directory);(directory/'transformer').mkdir(parents=True,exist_ok=True)
        (directory/'transformer/diffusion_pytorch_model.safetensors').write_bytes(b'original weights')
        return directory
    def run(argv,current,timeout=None):
        calls.append(argv)
        if argv[1]=='create':return subprocess.CompletedProcess(argv,0,'f'*64,'')
        if argv[1]=='start':
            # The container's only output is a report in the private stage directory.
            create=next(args for args in calls if args[1]=='create')
            stage=Path(next(value for value in create if value.endswith(':/stage')).rsplit(':',1)[0])
            (stage/'conversion.json').write_text(json.dumps({'converted_sha256':'0'*64}))
        if argv[1]=='inspect':
            labels={SETUP_OWNER_LABEL:'studio-test-owner',SETUP_LABEL:'fixture'}
            return subprocess.CompletedProcess(argv,0,json.dumps({'Id':'f'*64,'Config':{'Labels':labels}}),'')
        return subprocess.CompletedProcess(argv,0,'','')
    m.run=run;m.configure=lambda *args:calls.append('configured')
    monkeypatch.setattr(module,'snapshot',snapshot)
    with pytest.raises(ValueError,match='checksum'):module.wan(m,job)
    create=next(args for args in calls if args[1]=='create')
    assert '--device' not in create and create[create.index('--network')+1]=='none'
    assert create[create.index('--cap-drop')+1]=='ALL' and create[create.index('--security-opt')+1]=='no-new-privileges'
    assert create[create.index('--user')+1]==f'{os.getuid()}:{os.getgid()}'
    assert any(value.endswith('/source/model.safetensors:ro') for value in create)
    assert ['docker','rm','-f','f'*64] in calls and 'configured' not in calls
