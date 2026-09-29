import json
import zipfile
from concurrent.futures import ThreadPoolExecutor
import pytest
from studio.agents import Agents, AgentInput, AgentUpdateInput, RunInput
from studio.chat import Chats
from studio.documents import import_document
from studio.store import Store
from studio.registry import profile
from studio.export import export_project

@pytest.fixture
def setup(tmp_path, monkeypatch):
    store = Store(tmp_path)
    project = store.create_project('Agents')
    monkeypatch.setattr('studio.agents.resolve_profile',
                        lambda *args, **kwargs: profile('minicpm5-chat', 'write', 'chat'))
    class Worker:
        def cancel(self, identity):
            store.status(identity, 'cancelled', 'Stopped', cancel=1)
    agents = Agents(store, None, Worker(), Chats(store, None))
    return store, project, agents

def start(agents, agent, key='unique-agent-run-0001'):
    return agents.start(agent['id'], RunInput(instruction='Write a short factual brief.', client_id=key))

def complete(store, project, job, text='The budget is EUR 42.'):
    asset = store.add_asset(project['id'], 'text', 'Draft', text.encode(), '.md', {})
    store.status(job['id'], 'completed', 'Saved', asset=asset['id'])
    return asset

def test_two_durable_steps_idempotency_reopen_and_export(setup):
    store, project, agents = setup
    doc = import_document(store, project['id'], 'facts.txt', b'The budget is EUR 42.')
    agent = agents.create(project['id'], AgentInput(name='Brief', purpose='Summarise approved facts.', document_ids=[doc['id']]))
    with ThreadPoolExecutor(2) as pool:
        runs = list(pool.map(lambda _: start(agents, agent), range(2)))
    assert runs[0]['id'] == runs[1]['id']
    assert len(store.rows('SELECT id FROM jobs')) == 1
    run = runs[0]
    with pytest.raises(ValueError, match='already'):
        start(agents, agent, 'unique-agent-run-0002')
    request = run['jobs'][0]['request']
    assert 'EUR 42' in request['messages'][1]['content']
    assert request['profile']['package'] == 'minicpm5-2b'
    complete(store, project, run['jobs'][0])
    agents.tick(); agents.tick()
    reviewed = agents.get_run(run['id'])
    assert reviewed['state'] == 'reviewing'
    assert len(reviewed['jobs']) == 2
    assert reviewed['jobs'][1]['request']['messages'][-2]['role'] == 'assistant'
    assert reviewed['jobs'][1]['request']['profile'] == request['profile']
    reopened = Agents(Store(store.root), None, agents.worker, Chats(store, None))
    final = complete(store, project, reviewed['jobs'][1])
    reopened.tick(); reopened.tick()
    assert reopened.get_run(run['id'])['state'] == 'completed'
    assert reopened.get_run(run['id'])['asset'] == final['id']
    assert len(store.rows('SELECT id FROM jobs')) == 2
    with zipfile.ZipFile(export_project(store, project['id'])) as archive:
        exported = json.loads(archive.read('agents.json'))
        assert exported[0]['runs'][0]['text'] == 'The budget is EUR 42.'

@pytest.mark.parametrize('phase', ['drafting', 'reviewing'])
def test_cancellation_never_schedules_further_step(setup, phase):
    store, project, agents = setup
    agent = agents.create(project['id'], AgentInput(name='Draft', purpose='Help'))
    run = start(agents, agent)
    if phase == 'reviewing':
        complete(store, project, run['jobs'][0]); agents.tick()
    agents.cancel(run['id']); agents.tick(); agents.tick()
    assert agents.get_run(run['id'])['state'] == 'cancelled'
    assert len(store.rows('SELECT id FROM jobs')) == (1 if phase == 'drafting' else 2)

def test_failure_stops_and_source_scope_is_enforced(setup):
    store, project, agents = setup
    other = store.create_project('Private')
    doc = import_document(store, other['id'], 'private.txt', b'Private facts.')
    with pytest.raises(ValueError, match='this project'):
        agents.create(project['id'], AgentInput(name='Bad', purpose='Help', document_ids=[doc['id']]))
    with pytest.raises(ValueError, match='chat model'):
        agents.create(project['id'], AgentInput(name='Bad', purpose='Help', profile_id='image-standard'))
    agent = agents.create(project['id'], AgentInput(name='Valid', purpose='Help'))
    run = start(agents, agent)
    store.status(run['jobs'][0]['id'], 'failed', 'Model unavailable')
    agents.tick()
    assert agents.get_run(run['id'])['state'] == 'failed'
    assert len(store.rows('SELECT id FROM jobs')) == 1


def test_edit_preserves_active_run_snapshot_and_rejects_stale_version(setup):
    store, project, agents = setup
    doc = import_document(store, project['id'], 'facts.txt', b'The budget is EUR 42.')
    agent = agents.create(project['id'], AgentInput(name='Brief', purpose='Summarise approved facts.', document_ids=[doc['id']]))
    run = start(agents, agent)
    edited = AgentUpdateInput(name='Reviewer', purpose='Review supplied code.', template='code-review', expected_version=1)
    assert agents.update(agent['id'], edited)['definition']['version'] == 2
    with pytest.raises(ValueError, match='another window'):
        agents.update(agent['id'], edited)
    complete(store, project, run['jobs'][0], 'Original draft')
    agents.tick()
    review = agents.get_run(run['id'])
    assert review['definition'] == agent['definition']
    assert review['instruction'] == 'Write a short factual brief.'
    assert review['draft_text'] == 'Original draft'
    assert review['jobs'][1]['request']['context_ids'] == [doc['id']]
    assert 'Summarise approved facts.' in review['jobs'][1]['request']['messages'][0]['content']
    complete(store, project, review['jobs'][1]); agents.tick()
    next_run = start(agents, agent, 'unique-agent-run-0002')
    assert next_run['definition']['version'] == 2
    assert next_run['jobs'][0]['request']['context_ids'] == []
    assert 'Do not claim to inspect a repository or execute code or tests' in next_run['jobs'][0]['request']['messages'][0]['content']


def test_edit_validates_project_context_and_enabled_mcp_scope(setup):
    from studio.mcp_agents import AgentServers
    store, project, agents = setup
    agent = agents.create(project['id'], AgentInput(name='Brief', purpose='Help'))
    other = store.create_project('Other')
    doc = import_document(store, other['id'], 'private.txt', b'Private facts.')
    with pytest.raises(ValueError, match='this project'):
        agents.update(agent['id'], AgentUpdateInput(name='Bad', purpose='Help', document_ids=[doc['id']], expected_version=1))
    servers = AgentServers(agents)
    server = servers.create(project['id'], agent['id'])
    with store.connect() as db:
        db.execute('UPDATE mcp_agent_servers SET enabled=1 WHERE id=?', (server['id'],))
    body = AgentUpdateInput(name='Updated', purpose='A different purpose', expected_version=1)
    with pytest.raises(ValueError, match='Disable'):
        agents.update(agent['id'], body)
    assert agents.agent(agent['id'])['definition']['version'] == 1
    servers.configure(project['id'], server['id'], False)
    assert agents.update(agent['id'], body)['definition']['name'] == 'Updated'
