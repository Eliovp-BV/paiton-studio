import json
import zipfile
from concurrent.futures import ThreadPoolExecutor
import pytest
from studio.agents import Agents, AgentInput, RunInput
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
