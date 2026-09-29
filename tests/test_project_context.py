"""Exact opt-in context snapshots with no GPU, model readiness or execution."""
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

from fastapi import HTTPException
from pydantic import ValidationError
import pytest

from studio.agents import Agents, AgentInput, AgentUpdateInput, RunInput
from studio.chat import Chats, ChatSend
from studio.project_context import ProjectContext, BriefInput
from studio.registry import profile
from studio.store import Store


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    store = Store(tmp_path)
    project = store.create_project()['id']
    chats = Chats(store, None)
    class NoWorker:
        def __getattr__(self, name):
            pytest.fail('Context previews must not inspect a worker, load a model or execute work.')
    agents = Agents(store, None, NoWorker(), chats)
    def unavailable(*args, **kwargs):
        pytest.fail('Context inspection must work without model readiness or preflight.')
    monkeypatch.setattr('studio.chat.resolve_profile', unavailable)
    monkeypatch.setattr('studio.agents.resolve_profile', unavailable)
    return SimpleNamespace(store=store, project=project, chats=chats, agents=agents,
                           brief=ProjectContext(store))


def chat_body(**fields):
    return ChatSend(prompt='Explain the selected facts.', client_id='synthetic-context-0001', **fields)


def ready(monkeypatch):
    for module in ('chat', 'agents'):
        monkeypatch.setattr('studio.' + module + '.resolve_profile', lambda *args, **kwargs: profile('gptoss-chat', 'write', 'chat'))


def document(workspace, content):
    return workspace.store.add_asset(workspace.project, 'text', 'Approved facts', content.encode(), '.txt', {})


def complete(workspace, job, text):
    asset = workspace.store.add_asset(workspace.project, 'text', 'Synthetic reply', text.encode(), '.md', {})
    workspace.store.status(job['id'], 'completed', 'Saved fixture', asset=asset['id'])


def test_brief_initial_read_is_empty_and_save_is_versioned_project_scoped(workspace):
    p = workspace
    assert p.brief.get(p.project) == {'project': p.project, 'content': '', 'revision': 0, 'updated': None}
    assert not p.store.rows('SELECT * FROM preferences')
    saved = p.brief.save(p.project, BriefInput(content='Approved audience: local makers.', expected_revision=0))
    assert saved['revision'] == 1 and saved['updated'] > 0
    assert p.brief.snapshot(p.project, 1) == {'content': saved['content'], 'revision': 1}
    assert p.brief.snapshot(p.project, None) is None
    other = p.store.create_project()['id']
    assert p.brief.get(other)['revision'] == 0
    assert ProjectContext(Store(p.store.root)).get(p.project) == saved
    with pytest.raises(HTTPException) as stale:
        p.brief.save(p.project, BriefInput(content='Stale edit', expected_revision=0))
    assert stale.value.status_code == 409 and p.brief.get(p.project) == saved
    p.brief.save(p.project, BriefInput(content='', expected_revision=1))
    with pytest.raises(HTTPException, match='empty'):
        p.brief.snapshot(p.project, 2)
    with pytest.raises(HTTPException, match='changed'):
        p.brief.snapshot(p.project, 1)


@pytest.mark.parametrize('fields', [
    {'content': 'x' * 4001}, {'content': 'binary\0text'}, {'content': '\ud800'},
    {'expected_revision': -1}, {'expected_revision': True}, {'remote_url': 'https://invalid.example'},
])
def test_brief_validation_rejects_oversize_nontext_and_unsupported_fields(fields):
    with pytest.raises(ValidationError):
        BriefInput.model_validate({'content': 'Approved facts', 'expected_revision': 0, **fields})


def test_simultaneous_brief_edits_have_one_winner(workspace):
    p = workspace
    def save(text):
        try:
            return p.brief.save(p.project, BriefInput(content=text, expected_revision=0))
        except HTTPException as error:
            return error.status_code
    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(save, ['First draft', 'Second draft']))
    assert sum(isinstance(item, dict) for item in results) == 1 and 409 in results
    assert p.brief.get(p.project)['revision'] == 1


def test_new_chat_preview_is_exact_read_only_and_nonce_independent(workspace):
    p = workspace
    saved = p.brief.save(p.project, BriefInput(content='Product name: Cedar.', expected_revision=0))
    doc = document(p, 'Approved budget: EUR 42.')
    body = chat_body(project_brief_revision=saved['revision'], document_ids=[doc['id']], inherit_documents=False)
    preview = p.chats.preview(p.project, body)
    assert preview['kind'] == 'text' and preview['project_brief']['content'] == saved['content']
    # The selected document enters as a complete saved snapshot before the prompt.
    assert 'EUR 42' in preview['messages'][-2]['content'] and 'Product name: Cedar.' in preview['messages'][-1]['content']
    assert preview['sources'][0]['id'] == doc['id'] and len(preview['sources'][0]['sha256']) == 64
    assert preview['characters'] == sum(len(message['content']) for message in preview['messages'])
    assert preview['history'] == {'included_turns': 0, 'omitted_turns': 0, 'excerpted': False}
    assert p.chats.preview(p.project, body.model_copy(update={'client_id': 'different-context-0002'}))['fingerprint'] == preview['fingerprint']
    assert not p.store.rows('SELECT * FROM chats') and not p.store.rows('SELECT * FROM jobs')


def test_new_preview_matches_actual_created_chat_and_queued_snapshot(workspace, monkeypatch):
    p = workspace
    p.brief.save(p.project, BriefInput(content='Audience: local makers.', expected_revision=0))
    body = chat_body(project_brief_revision=1)
    preview = p.chats.preview(p.project, body)
    chat = p.chats.create(p.project, 'New conversation')
    ready(monkeypatch)
    job = p.chats.send(chat['id'], body.model_copy(update={'context_fingerprint': preview['fingerprint']}))
    assert job['request']['context_snapshot'] == preview
    assert job['request']['messages'] == preview['messages']
    assert job['request']['project_brief'] == {'content': 'Audience: local makers.', 'revision': 1}
    p.brief.save(p.project, BriefInput(content='Updated audience.', expected_revision=1))
    assert p.chats.send(chat['id'], body)['id'] == job['id'], 'An accepted retry keeps its immutable context.'
    assert p.chats.get(chat['id'])['turns'][0]['project_brief'] == job['request']['project_brief']


def test_chat_brief_is_excluded_unless_requested_and_image_context_is_prompt_only(workspace):
    p = workspace
    p.brief.save(p.project, BriefInput(content='BRIEF_NOT_SELECTED', expected_revision=0))
    preview = p.chats.preview(p.project, chat_body())
    assert preview['project_brief'] is None and 'BRIEF_NOT_SELECTED' not in str(preview['messages'])
    image = p.chats.preview(p.project, chat_body(mode='image'))
    assert image['kind'] == 'image' and image['sources'] == [] and image['project_brief'] is None
    assert image['messages'] == [{'role': 'user', 'content': 'Explain the selected facts.'}]
    with pytest.raises(ValueError, match='text context'):
        p.chats.preview(p.project, chat_body(mode='image', project_brief_revision=1))


@pytest.mark.parametrize('change', ['document', 'prompt', 'profile'])
def test_changed_chat_context_rejects_fingerprint_before_model_preflight(workspace, change):
    p = workspace
    doc = document(p, 'Original approved facts.')
    body = chat_body(document_ids=[doc['id']], inherit_documents=False)
    preview = p.chats.preview(p.project, body)
    chat = p.chats.create(p.project, 'Context test')
    if change == 'document':
        p.store.file(doc).write_text('External source revision.')
    elif change == 'prompt':
        body = body.model_copy(update={'prompt': 'A different task.'})
    else:
        body = body.model_copy(update={'profile_id': 'gptoss-chat'})
    with pytest.raises(HTTPException) as stale:
        p.chats.send(chat['id'], body.model_copy(update={'context_fingerprint': preview['fingerprint']}))
    assert stale.value.status_code == 409 and not p.store.rows('SELECT * FROM jobs')


def test_chat_preview_enforces_conversation_and_document_project_ownership(workspace):
    p = workspace
    other = p.store.create_project()['id']
    chat = p.chats.create(other, 'Other project')
    with pytest.raises(ValueError, match='this project'):
        p.chats.preview(p.project, chat_body(), chat['id'])
    private = p.store.add_asset(other, 'text', 'Private fixture', b'Other project facts', '.txt', {})
    with pytest.raises(ValueError, match='this project'):
        p.chats.preview(p.project, chat_body(document_ids=[private['id']]))


def test_history_is_complete_at_enqueue_and_reported_without_excerpting(workspace, monkeypatch):
    # The complete saved transcript is submitted; the runtime fits it to the
    # selected profile's exact token budget instead of an enqueue-time window.
    p = workspace
    ready(monkeypatch)
    chat = p.chats.create(p.project, 'History')
    for index in range(5):
        job = p.chats.send(chat['id'], chat_body().model_copy(update={'client_id': f'history-context-{index:04}'}))
        complete(p, job, 'A' * 2000)
    preview = p.chats.preview(p.project, chat_body(), chat['id'])
    assert preview['history'] == {'included_turns': 5, 'omitted_turns': 0, 'excerpted': False}
    assert len(preview['messages']) == 12
    assert 'Middle omitted' not in str(preview['messages']), 'Saved replies are never excerpted at enqueue time.'
    assert len(p.chats.get(chat['id'])['turns']) == 5


@pytest.mark.parametrize('kind', ['chat', 'agent'])
def test_brief_changed_during_preflight_is_rejected_inside_enqueue_transaction(workspace, monkeypatch, kind):
    p = workspace
    p.brief.save(p.project, BriefInput(content='Original brief.', expected_revision=0))
    def changed(*args, **kwargs):
        p.brief.save(p.project, BriefInput(content='Changed in another window.', expected_revision=1))
        return profile('gptoss-chat', 'write', 'chat')
    monkeypatch.setattr('studio.' + ('chat' if kind == 'chat' else 'agents') + '.resolve_profile', changed)
    with pytest.raises(HTTPException) as stale:
        if kind == 'chat':
            chat = p.chats.create(p.project, 'Brief race')
            p.chats.send(chat['id'], chat_body(project_brief_revision=1))
        else:
            agent = p.agents.create(p.project, AgentInput(name='Brief race', purpose='Review facts.'))
            p.agents.start(agent['id'], RunInput(instruction='Review facts.', client_id='brief-race-agent-0001', project_brief_revision=1))
    assert stale.value.status_code == 409 and 'while preparing' in stale.value.detail
    assert not p.store.rows('SELECT * FROM jobs') and not p.store.rows('SELECT * FROM agent_runs')


def test_agent_preview_includes_entire_selected_document_without_silent_4000_character_cut(workspace, monkeypatch):
    p = workspace
    text = ''.join(f'CHUNK-{index:02} ' + 'x' * 1180 + '\n' for index in range(8))
    doc = document(p, text)
    agent = p.agents.create(p.project, AgentInput(name='Document reader', purpose='Explain approved facts.', document_ids=[doc['id']]))
    body = RunInput(instruction='Summarize the supplied facts.', client_id='agent-context-0001')
    preview = p.agents.preview(agent['id'], body)
    assert len(text) > 4000 and text in preview['messages'][1]['content']
    assert [source['id'] for source in preview['sources']] == [doc['id']]
    assert len(preview['sources'][0]['sha256']) == 64 and preview['sources'][0]['characters'] == len(text)
    assert not p.store.rows('SELECT * FROM jobs') and not p.store.rows('SELECT * FROM agent_runs')
    ready(monkeypatch)
    run = p.agents.start(agent['id'], body.model_copy(update={'context_fingerprint': preview['fingerprint']}))
    assert run['jobs'][0]['request']['context_snapshot'] == preview
    assert run['jobs'][0]['request']['messages'] == preview['messages']


def test_agent_review_retains_brief_and_rebuilds_actual_step_snapshot(workspace, monkeypatch):
    p = workspace
    p.brief.save(p.project, BriefInput(content='Original approved brief.', expected_revision=0))
    agent = p.agents.create(p.project, AgentInput(name='Reviewer', purpose='Review approved facts.'))
    body = RunInput(instruction='Write the result.', client_id='agent-context-0001', project_brief_revision=1)
    preview = p.agents.preview(agent['id'], body)
    ready(monkeypatch)
    run = p.agents.start(agent['id'], body.model_copy(update={'context_fingerprint': preview['fingerprint']}))
    p.brief.save(p.project, BriefInput(content='NEW_BRIEF_NOT_FOR_THIS_RUN', expected_revision=1))
    complete(p, run['jobs'][0], 'Draft text. ' + 'a' * 5500)
    p.agents.tick()
    review = p.agents.get_run(run['id'])['jobs'][1]['request']
    assert review['project_brief'] == preview['project_brief']
    assert review['context_snapshot']['messages'] == review['messages']
    assert len(review['messages']) == 4 and review['context_snapshot']['fingerprint'] != preview['fingerprint']
    # The complete draft stays in the review request; the runtime budgets it exactly.
    assert review['context_history']['excerpted'] is False
    assert 'a' * 5500 in review['messages'][2]['content']
    assert review['context_characters'] == sum(len(message['content']) for message in review['messages'])
    assert 'NEW_BRIEF_NOT_FOR_THIS_RUN' not in str(review)
    assert p.agents.start(agent['id'], body)['id'] == run['id']


def test_agent_definition_change_invalidates_preview_without_model_preflight(workspace):
    p = workspace
    agent = p.agents.create(p.project, AgentInput(name='Planner', purpose='Plan a launch.'))
    body = RunInput(instruction='Create a plan.', client_id='agent-context-0001')
    preview = p.agents.preview(agent['id'], body)
    p.agents.update(agent['id'], AgentUpdateInput(name='Planner', purpose='Review a different launch.', expected_version=1))
    with pytest.raises(HTTPException) as stale:
        p.agents.start(agent['id'], body.model_copy(update={'context_fingerprint': preview['fingerprint']}))
    assert stale.value.status_code == 409 and not p.store.rows('SELECT * FROM jobs')


def test_another_agent_controller_edit_during_preflight_is_rechecked_in_transaction(workspace, monkeypatch):
    p = workspace
    agent = p.agents.create(p.project, AgentInput(name='Planner', purpose='Plan the approved launch.'))
    other_controller = Agents(p.store, None, object(), p.chats)
    def changed(*args, **kwargs):
        other_controller.update(agent['id'], AgentUpdateInput(name='Planner', purpose='Different approved purpose.', expected_version=1))
        return profile('gptoss-chat', 'write', 'chat')
    monkeypatch.setattr('studio.agents.resolve_profile', changed)
    with pytest.raises(HTTPException) as conflict:
        p.agents.start(agent['id'], RunInput(instruction='Prepare the plan.', client_id='agent-controller-0001'))
    assert conflict.value.status_code == 409 and 'agent changed' in conflict.value.detail
    assert not p.store.rows('SELECT * FROM jobs') and not p.store.rows('SELECT * FROM agent_runs')


@pytest.mark.parametrize('kind', ['chat', 'agent'])
def test_changed_model_default_during_preflight_invalidates_selection_snapshot(workspace, monkeypatch, kind):
    from studio.preferences import SettingsInput, save_settings
    p = workspace
    def changed(*args, **kwargs):
        save_settings(p.store, SettingsInput.model_validate({'defaults': {'chat': 'gptoss-chat'}}))
        return profile('gptoss-chat', 'write', 'chat')
    monkeypatch.setattr('studio.' + ('chat' if kind == 'chat' else 'agents') + '.resolve_profile', changed)
    with pytest.raises(HTTPException) as stale:
        if kind == 'chat':
            chat = p.chats.create(p.project, 'Default race')
            p.chats.send(chat['id'], chat_body())
        else:
            agent = p.agents.create(p.project, AgentInput(name='Default race', purpose='Review facts.'))
            p.agents.start(agent['id'], RunInput(instruction='Review facts.', client_id='default-race-agent-0001'))
    assert stale.value.status_code == 409 and 'default model selection changed' in stale.value.detail
    assert not p.store.rows('SELECT * FROM jobs')


def test_default_agent_and_guarded_external_runs_do_not_inherit_project_brief(workspace, monkeypatch):
    p = workspace
    p.brief.save(p.project, BriefInput(content='PRIVATE_BRIEF_NOT_SELECTED', expected_revision=0))
    agent = p.agents.create(p.project, AgentInput(name='External draft', purpose='Use only supplied facts.'))
    calls = []
    ready(monkeypatch)
    run = p.agents.start(agent['id'], RunInput(instruction='Draft from this instruction.', client_id='external-default-0001'),
                         guard=lambda db: calls.append('authorized'))
    assert calls == ['authorized']
    request = run['jobs'][0]['request']
    assert request['project_brief'] is None
    assert 'PRIVATE_BRIEF_NOT_SELECTED' not in str(request)
