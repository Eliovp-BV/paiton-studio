"""CPU-only immutable Qwen precision choices for new and existing chats."""
from copy import deepcopy
import json
from types import SimpleNamespace

import pytest
from studio.chat import Chats, ChatOptions, ChatSend, ChatRegenerate
from studio.conversation_options import apply_options
from studio.preferences import get_settings
from studio.registry import profile
from studio.store import Store


@pytest.fixture
def state(tmp_path, monkeypatch):
    store = Store(tmp_path)
    project = store.create_project('Precision snapshots')
    checked = []
    runtime = SimpleNamespace(config={}, preflight=lambda request: checked.append(deepcopy(request)))
    def resolve(store, runtime, role, identity, options=None):
        selected = apply_options(profile('qwen38-mxfp4-chat', 'write'), options)
        runtime.preflight({'profile':selected})
        return selected
    monkeypatch.setattr('studio.chat.resolve_profile', resolve)
    return SimpleNamespace(store=store, project=project['id'], runtime=runtime, checked=checked, chats=Chats(store,runtime))


def create(s):
    return s.chats.create(s.project,'Precision')


def send(s, chat, key='weights-snapshot-first'):
    return s.chats.send(chat['id'],ChatSend(prompt='Summarize this.',client_id=key))


def completed(s, job):
    asset=s.store.add_asset(s.project,'text','Reply',b'Original completed reply.','.md',{})
    s.store.status(job['id'],'completed','Saved',asset=asset['id'])


def preferences(s, **changes):
    value=get_settings(s.store)
    for key, patch in changes.items():value[key].update(patch)
    with s.store.connect() as db:db.execute("INSERT INTO preferences VALUES('settings',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",(json.dumps(value),))


@pytest.mark.parametrize('enabled',[None,False,True])
def test_only_new_chat_uses_registered_package_default(state,enabled):
    s=state; first=create(s)
    if enabled is not None:s.runtime.config['qwen38_w3a4_default']=enabled
    second=create(s)
    assert first['options']['conversation']['weights']=='mxfp4'
    assert s.chats.get(first['id'])['options']['conversation']['weights']=='mxfp4'
    expected='w3a4' if enabled is True else 'mxfp4'
    assert second['options']['conversation']['weights']==expected
    assert second['conversation_details']['weights']==expected
    assert s.checked==[] # Merely opening/creating a chat cannot touch the GPU.
    with s.store.connect() as db:
        saved=json.loads(db.execute('SELECT value FROM chat_preferences WHERE chat=?',(second['id'],)).fetchone()['value'])
    assert saved['conversation']['weights']==expected


def test_stored_default_survives_cold_verification_until_request_preflight(state):
    s=state;s.runtime.config['qwen38_w3a4_default']=True
    chat=create(s)
    assert chat['options']['conversation']['weights']=='w3a4'
    def missing(request):raise ValueError('Verify the optional weights before use.')
    s.runtime.preflight=missing
    with pytest.raises(ValueError,match='Verify'):send(s,chat)
    assert s.store.rows('SELECT id FROM jobs')==[]
    assert s.chats.get(chat['id'])['options']['conversation']['weights']=='w3a4'


def test_old_preference_without_weights_always_reads_mxfp4(state):
    s=state;chat=create(s)
    with s.store.connect() as db:
        db.execute('UPDATE chat_preferences SET value=? WHERE chat=?',(json.dumps({'conversation':{'context_mode':'long','reuse_cache':False},'tools_enabled':True}),chat['id']))
    s.runtime.config['qwen38_w3a4_default']=True
    value=s.chats.get(chat['id'])
    assert value['options']=={'conversation':{'context_mode':'long','reuse_cache':False,'weights':'mxfp4'},'tools_enabled':True}
    assert send(s,chat)['request']['profile']['conversation_options']['weights']=='mxfp4'


def test_old_chat_without_preferences_does_not_inherit_global_precision(state):
    s=state;chat=create(s)
    with s.store.connect() as db:db.execute('DELETE FROM chat_preferences WHERE chat=?',(chat['id'],))
    s.runtime.config['qwen38_w3a4_default']=True
    preferences(s,conversation={'weights':'w3a4','context_mode':'long'})
    assert s.chats.options(chat['id'])['conversation']=={'weights':'mxfp4','context_mode':'long','reuse_cache':False}


@pytest.mark.parametrize('mode',['short','extra_long'])
def test_new_chat_respects_explicit_other_model(state,mode):
    s=state;s.runtime.config['qwen38_w3a4_default']=True
    preferences(s,conversation={'context_mode':mode},defaults={'chat':'gptoss-chat'})
    assert create(s)['options']['conversation']['weights']=='mxfp4'


def test_weights_choice_and_saved_receipt_survive_default_and_chat_changes(state):
    s=state;s.runtime.config['qwen38_w3a4_default']=True
    chat=create(s);first=send(s,chat); completed(s,first)
    s.runtime.config['qwen38_w3a4_default']=False
    assert s.chats.get(chat['id'])['options']['conversation']['weights']=='w3a4'
    s.chats.options(chat['id'],ChatOptions(conversation={'weights':'mxfp4'}))
    second=s.chats.regenerate(chat['id'],first['id'],ChatRegenerate(client_id='weights-regenerate-next'))
    assert first['request']['profile']['conversation_options']['weights']=='w3a4'
    assert s.store.job(first['id'])['request']==first['request']
    assert second['request']['profile']['conversation_options']['weights']=='mxfp4'
    assert [request['profile']['conversation_options']['weights'] for request in s.checked]==['w3a4','mxfp4']
    value=s.chats.get(chat['id'])
    assert value['turns'][0]['job']['request']['profile']['conversation_options']['weights']=='w3a4'
    assert value['conversation_details']['weights']=='mxfp4'
    assert value['conversation_details']['context']==8192


@pytest.mark.parametrize('mode',['short','long','extra_long'])
def test_new_conversation_context_preview_matches_registered_default(state,mode):
    s=state;s.runtime.config['qwen38_w3a4_default']=True
    preferences(s,conversation={'context_mode':mode})
    body=ChatSend(prompt='Start a new chat.',client_id='weights-context-preview')
    preview=s.chats.preview(s.project,body)
    chat=create(s)
    job=s.chats.send(chat['id'],body.model_copy(update={'context_fingerprint':preview['fingerprint']}))
    assert job['request']['profile']['conversation_options']['weights']=='w3a4'
    assert job['request']['context_fingerprint']==preview['fingerprint']
    assert job['request']['profile']['context']=={'short':8192,'long':65536,'extra_long':200000}[mode]
