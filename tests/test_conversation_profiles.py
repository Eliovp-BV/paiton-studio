"""CPU contracts for profile selection, durable memory and bounded project tools."""
from copy import deepcopy
import json
from pathlib import Path
from types import SimpleNamespace
import pytest
from fastapi.testclient import TestClient
from studio.app import create_app
from studio.chat import Chats, ChatSend, ChatOptions
from studio.registry import profile, validate_snapshot
from studio.conversation_options import ConversationOptions, apply_options, engine_profile, image_for, launch_identity, IMAGES
from studio.conversation_memory import select_context, records
from studio.project_tools import ProjectTools, source_snapshots, definitions
from studio.documents import import_document
from studio.store import Store
from studio.runtime import Runtime, Cancelled
from studio.chat_adapters import writing_body
from scripts.stream_protocol import StreamResponse

@pytest.mark.parametrize('mode,apc,ceiling', [('short',False,8192),('long',False,65536),('long',True,65536),('extra_long',False,200000)])
def test_released_contracts_match_target_drafter_and_cache(mode,apc,ceiling):
    p=apply_options(profile('qwen38-mxfp4-chat','write'),dict(context_mode=mode,reuse_cache=apc))
    assert validate_snapshot(p)==p
    launch=engine_profile(p['conversation_options']); args=launch['arguments']
    assert int(args[args.index('--max-model-len')+1])==ceiling
    assert json.loads(args[args.index('--speculative-config')+1])['max_model_len']==ceiling
    assert args[args.index('--tool-call-parser')+1]=='qwen3_xml'
    assert args[args.index('--max-num-seqs')+1]=='1'
    assert args[args.index('--max-num-batched-tokens')+1]=='4096'
    assert ('--enable-prefix-caching' in args)==apc
    assert args[args.index('--mamba-cache-mode')+1]==('align' if apc else 'none')
    assert launch['environment']['PAITON_EXPERIMENTAL_GDN_PREFILL']==('0' if apc else '1')
    assert image_for(p)==IMAGES['200k' if mode=='extra_long' else '64k']
    tampered=deepcopy(p);tampered['context']+=1
    with pytest.raises(ValueError):validate_snapshot(tampered)

@pytest.mark.parametrize('mode',['short','extra_long'])
def test_unsupported_combinations_rejected(mode):
    with pytest.raises(ValueError,match='64K'):ConversationOptions(context_mode=mode,reuse_cache=True)


def test_long_context_cannot_silently_fall_back_to_small_model(tmp_path,monkeypatch):
    from studio.preferences import resolve_profile
    from studio.runtime import RuntimeFailure
    monkeypatch.setattr('studio.preferences.gpu_status',lambda:{'name':'AMD Radeon AI PRO R9700','architecture':'gfx1201','driver_available':True,'gpu_count':1,'total':32*1024**3})
    checked=[]
    def preflight(request):
        checked.append(request['profile']['package'])
        if request['profile']['package']=='qwen38-mxfp4':raise RuntimeFailure('200K image missing')
    with pytest.raises(ValueError,match='No installed'):
        resolve_profile(Store(tmp_path),SimpleNamespace(preflight=preflight),'chat','auto',options={'context_mode':'extra_long','reuse_cache':False})
    assert checked==['qwen38-mxfp4']


def test_warm_identity_separates_same_image_profiles_and_sources(tmp_path):
    runtime=Runtime(Store(tmp_path),{'qwen38_mxfp4_cache_volume':'pinned-cache'})
    p=apply_options(profile('qwen38-mxfp4-chat','write'),{})
    import time
    sources=runtime.chat_source(p['package'],p['revision'])[0]
    runtime._warm=dict(container='owned',image=image_for(p),package=p['package'],revision=p['revision'],until=time.monotonic()+60,launch_identity=launch_identity(p,sources))
    assert runtime.warm_for({'profile':p})
    for option in ({'context_mode':'long'},{'context_mode':'long','reuse_cache':True},{'context_mode':'extra_long'}):
        assert not runtime.warm_for({'profile':apply_options(p,option)})
    runtime.config['qwen38_mxfp4_cache_volume']='another-pinned-cache'
    assert not runtime.warm_for({'profile':p})

@pytest.fixture
def conversation(tmp_path,monkeypatch):
    store=Store(tmp_path); project=store.create_project('Memory')
    monkeypatch.setattr('studio.chat.resolve_profile',lambda s,r,role,identity,options=None:apply_options(profile('qwen38-mxfp4-chat','write'),options))
    chats=Chats(store,None);chat=chats.create(project['id'],'Memory')
    return store,project,chats,chat


def send(chats,chat,text,key,**kw):return chats.send(chat['id'],ChatSend(prompt=text,client_id='memory-test-'+key,**kw))
def complete(store,p,job,text='Saved reply'):
    asset=store.add_asset(p['id'],'text','Reply',text.encode(),'.md',{})
    store.status(job['id'],'completed','Saved',asset=asset['id'])


def test_options_persist_without_mutating_active_snapshot(conversation):
    store,p,chats,chat=conversation
    job=send(chats,chat,'Remember Cedar-731','first')
    chats.options(chat['id'],ChatOptions(conversation={'context_mode':'long','reuse_cache':True},tools_enabled=True))
    reopened=Chats(Store(store.root),None)
    assert reopened.get(chat['id'])['profile_change_pending']
    assert store.job(job['id'])['request']['profile']['context']==8192
    complete(store,p,job)
    next_job=send(reopened,chat,'Recall the name','second')
    assert next_job['request']['profile']['context']==65536 and next_job['request']['tools_enabled']
    assert 'Cedar-731' in json.dumps(next_job['request']['messages'])
    assert not reopened.get(chat['id'])['profile_change_pending']


def test_documents_preserve_submitted_versions_and_append_updates(conversation):
    store,p,chats,chat=conversation
    doc=import_document(store,p['id'],'brief.txt',b'Budget EUR 42. Decision Cedar-731.')
    first=send(chats,chat,'What is the budget?','first',document_ids=[doc['id']]);complete(store,p,first,'EUR 42.')
    second=send(chats,chat,'What was the decision?','second')
    messages=second['request']['messages']
    assert messages[:len(first['request']['messages'])]==first['request']['messages']
    assert json.dumps(messages).count('DOCUMENT SNAPSHOT')==1
    complete(store,p,second,'Cedar-731.')
    extracted=store.asset(doc['metadata']['extracted_text']);store.file(extracted).write_text('Budget now EUR 57.')
    third=send(Chats(Store(store.root),None),chat,'Use the updated budget','third')
    text=json.dumps(third['request']['messages'])
    assert 'EUR 42' in text and 'DOCUMENT UPDATE' in text and 'EUR 57' in text
    old=first['request']['source_snapshots'][0]
    assert 'EUR 42' in (store.root/old['path']).read_text()


def test_legacy_document_excerpts_survive_reopening(conversation):
    store,p,chats,chat=conversation
    job=send(chats,chat,'What did the brief say?','first')
    request=job['request'];request.pop('turn_messages');request['messages'][-1]['content']+='\nDOCUMENT old.txt excerpt 1: the deadline is Friday.'
    with store.connect() as db:db.execute('UPDATE jobs SET request=? WHERE id=?',(json.dumps(request),job['id']))
    complete(store,p,job)
    next_job=send(chats,chat,'Recall the deadline','second')
    assert 'deadline is Friday' in json.dumps(next_job['request']['messages'])


def test_compact_polling_keeps_complete_canonical_history_locally(conversation):
    store,p,chats,chat=conversation
    source=import_document(store,p['id'],'long.txt',b'Background source. '*6000)
    job=send(chats,chat,'Summarize the source','first',document_ids=[source['id']])
    full=chats.get(chat['id']);small=chats.get(chat['id'],compact=True)
    assert len(json.dumps(small))<len(json.dumps(full))/10
    assert 'messages' in store.job(job['id'])['request']
    complete(store,p,job)
    cleared=send(chats,chat,'Continue without source tools','second',document_ids=[])
    assert cleared['request']['source_snapshots']==[]
    assert 'Background source.' in json.dumps(cleared['request']['messages'])


def test_retry_respects_revoked_tool_permission(conversation):
    store,p,chats,chat=conversation;chats.options(chat['id'],ChatOptions(tools_enabled=True))
    job=send(chats,chat,'Save a draft','first');store.status(job['id'],'failed','Stopped')
    chats.options(chat['id'],ChatOptions(tools_enabled=False))
    with pytest.raises(ValueError,match='turned off'):chats.retry(chat['id'],job['id'])
    chats.options(chat['id'],ChatOptions(tools_enabled=True))
    assert chats.retry(chat['id'],job['id'])['id']==job['id']


def test_context_selection_uses_entire_body_and_reserves_output(tmp_path):
    store=Store(tmp_path);seen=[]
    # Deterministic fake tokens verify budgeting logic; real tokenizer equality is a GPU test.
    def tokenize(body):
        seen.append(deepcopy(body));return sum(len(m.get('content') or '') for m in body['messages'])+len(json.dumps(body.get('tools',[])))+17
    original=dict(model='local',messages=[dict(role='system',content='System'),dict(role='user',content='facts Cedar-731 gold '+('x'*1100)),dict(role='assistant',content='Decision retained'),dict(role='user',content='Recall it')],tools=definitions(),max_tokens=128)
    summaries=[]
    def summarize(body):summaries.append(body);return 'Facts: Cedar-731. Preferences: gold. Unfinished work: review.'
    selected,info=select_context(store,'chat',original,2600,tokenize,summarize,lambda:None)
    assert info['summarized'] and info['input_tokens']+128<=2600
    assert all('System' in str(b) or 'Summarize' in str(b) for b in seen)
    assert selected['tools']==original['tools'] and len(original['messages'][1]['content'])>1100
    assert all(tokenize(b)+b['max_tokens']<=2600 for b in summaries)
    growing=deepcopy(original);growing['messages'] += [dict(role='assistant',content='OK'),dict(role='user',content='Continue')]
    old=len(summaries);again,second=select_context(store,'chat',growing,2600,tokenize,summarize,lambda:None)
    assert second['summary_source_hash']==info['summary_source_hash'] and len(summaries)==old
    assert again['messages'][:len(selected['messages'])]==selected['messages']
    changed=deepcopy(growing);changed['messages'][1]['content']=changed['messages'][1]['content'].replace('gold','blue')
    _,new=select_context(store,'chat',changed,2600,tokenize,summarize,lambda:None)
    assert new['summary_source_hash']!=info['summary_source_hash']


def test_oversized_latest_request_is_rejected_not_silently_clipped(tmp_path):
    body=dict(model='local',messages=[dict(role='user',content='x'*5000)],max_tokens=100)
    with pytest.raises(ValueError,match='alone exceeds'):
        select_context(Store(tmp_path),'chat',body,1000,lambda b:sum(len(m['content']) for m in b['messages']),lambda b:'summary',lambda:None)
    assert len(body['messages'][0]['content'])==5000


def test_streamed_calls_are_assembled_and_truncation_is_rejected():
    stream=StreamResponse(True)
    stream.feed({'choices':[{'delta':{'tool_calls':[{'index':0,'id':'call_1','function':{'name':'save_code_draft','arguments':'{"name":"a.py",'}}]}}]})
    stream.feed({'choices':[{'delta':{'tool_calls':[{'index':0,'function':{'arguments':'"content":"print(1)"}'}}]},'finish_reason':'tool_calls'}]})
    call=stream.result()['choices'][0]['message']['tool_calls'][0]
    assert call['id']=='call_1' and json.loads(call['function']['arguments'])['content']=='print(1)'
    for finish in ('length',None):
        bad=StreamResponse(True);bad.feed({'choices':[{'delta':{'tool_calls':[{'index':0,'id':'bad','function':{'name':'save_code_draft','arguments':'{"name":'}}]},'finish_reason':finish}]})
        with pytest.raises(ValueError):bad.result()
    denied=StreamResponse(False)
    with pytest.raises(ValueError,match='not enabled'):denied.feed({'choices':[{'delta':{'tool_calls':[{'index':0}]}}]})


def test_project_tool_permissions_receipts_and_bounded_sources(conversation):
    store,p,chats,chat=conversation;tool=ProjectTools(store)
    source=import_document(store,p['id'],'source.py',('DATA '*5000).encode());sources=source_snapshots(store,p['id'],[source['id']])
    result=tool.execute(p['id'],'turn','read','read_project_source',{'source_id':source['id']},sources)
    assert len(result['text'])==6000 and result['truncated']
    args=dict(name='../../file.py',content='print(1)')
    first=tool.execute(p['id'],'turn','save','save_code_draft',args,sources)
    again=tool.execute(p['id'],'turn','save','save_code_draft',args,sources)
    assert again==first and first['name']=='file.py'
    assert store.asset(first['asset_id'])['metadata']['executable'] is False
    with pytest.raises(ValueError,match='different'):tool.execute(p['id'],'turn','save','save_code_draft',{**args,'content':'print(2)'},sources)
    other=store.create_project('Other')
    with pytest.raises(ValueError,match='another project'):tool.execute(other['id'],'turn','read','read_project_source',{'source_id':source['id']},sources)
    with pytest.raises(ValueError,match='not permitted'):tool.execute(p['id'],'turn','shell','shell',{},sources)
    def cancelled():raise Cancelled()
    with pytest.raises(Cancelled):tool.execute(p['id'],'turn','never','save_code_draft',args,sources,cancelled)
    assert len(store.rows("SELECT id FROM assets WHERE metadata LIKE '%assistant-code-draft%'"))==1


def test_tool_loop_retry_replays_response_and_reuses_saved_draft(conversation):
    from studio.conversation_runner import run
    store,p,chats,chat=conversation;chats.options(chat['id'],ChatOptions(tools_enabled=True))
    job=send(chats,chat,'Save a code draft','first',mode='code')
    body=writing_body(job['request']);directory=store.root/'jobs'/job['id'];directory.mkdir(parents=True,exist_ok=True)
    tool=dict(id='call_saved',type='function',function=dict(name='save_code_draft',arguments=json.dumps(dict(name='a.py',content='print(1)'))))
    replies=[dict(role='assistant',content='',tool_calls=[tool]),None,dict(role='assistant',content='Saved a.py for review.')]
    calls=[]
    class Fake:
        def __init__(self):self.store=store
        def check_cancel(self,job):pass
        def http(self,*args,**kwargs):return {'count':200}
        def stream(self,job,command,limit):
            calls.append(command);reply=replies.pop(0)
            if reply is None:raise Cancelled()
            path=directory/'calls'/command[-1].split('/')[-1]
            (path/'writing-result.json').write_text(json.dumps(dict(choices=[dict(message=reply,finish_reason='tool_calls' if reply.get('tool_calls') else 'stop')],usage={})))
    fake=Fake()
    with pytest.raises(Cancelled):run(fake,job,'owned',8000,body,directory)
    response,meta=run(fake,job,'owned',8000,body,directory)
    assert response['choices'][0]['message']['content']=='Saved a.py for review.'
    assert len(store.rows("SELECT id FROM assets WHERE metadata LIKE '%assistant-code-draft%'"))==1
    assert len(calls)==3 and len(meta['tool_artifacts'])==1
    transcript=records(store,job['id'])
    assert transcript[-1]['body']['messages'][-1]['tool_call_id']=='call_saved'
    assert transcript[-1]['body']['messages'][-2]['tool_calls'][0]['id']=='call_saved'


def test_settings_api_preserves_new_options_from_older_tabs(tmp_path):
    app=create_app(tmp_path,{},worker_enabled=False)
    with TestClient(app) as client:
        token=client.get('/api/session').json()['token']
        headers={'X-Studio-Token':token}
        # The same HTTP endpoints are exercised by the browser, including validation.
        r=client.put('/api/settings',json={'conversation':{'context_mode':'long','reuse_cache':True}},headers=headers)
        assert r.status_code==200,r.text
        r=client.put('/api/settings',json={'defaults':{}},headers=headers)
        assert r.json()['conversation']=={'context_mode':'long','reuse_cache':True}
        bad=client.put('/api/settings',json={'conversation':{'context_mode':'extra_long','reuse_cache':True}},headers=headers)
        assert bad.status_code==422
