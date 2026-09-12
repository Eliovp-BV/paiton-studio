"""No-network/no-GPU tests of pinned setup and public vocabulary preparation."""
import hashlib,json,subprocess
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
    assert stopped==['owned-vocab-id']
    assert not list((tmp_path/'runtime-cache/gptoss/harmony').iterdir())
