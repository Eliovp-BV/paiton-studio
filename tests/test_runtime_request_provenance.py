"""Every transactional job producer records its runtime before persisting work."""
from types import SimpleNamespace

import pytest

from studio.agents import Agents, AgentInput, RunInput
from studio.chat import Chats, ChatSend
from studio.registry import profile
from studio.store import Store
from studio.websites import Websites, WebsiteInput


FIRST = 'sha256:' + '1' * 64
SECOND = 'sha256:' + '2' * 64
CHANNELS = ['chat', 'agent', 'website']


@pytest.fixture
def producers(tmp_path, monkeypatch):
    store = Store(tmp_path)
    project = store.create_project()['id']
    calls, selected = [], [FIRST]
    def prepare(request):
        calls.append(request)
        return request if request.get('runtime_image') else {
            **request, 'runtime_image': selected[0], 'runtime_ref': 'synthetic-approved-package'}
    store.prepare_request = prepare
    def resolve(store, runtime, role, identity='auto', **kwargs):
        return profile({'image': 'image-standard', 'website': 'qwen38-mxfp4-website',
                        'chat': 'minicpm5-chat'}[role], 'image' if role == 'image' else 'write', role)
    for module in ('agents', 'chat', 'websites'):
        monkeypatch.setattr('studio.' + module + '.resolve_profile', resolve)
    worker = SimpleNamespace(cancel=lambda identity: store.status(identity, 'cancelled', 'Stopped', cancel=1))
    chats = Chats(store, None)
    return SimpleNamespace(store=store, project=project, calls=calls, selected=selected, chats=chats,
                           agents=Agents(store, None, worker, chats),
                           websites=Websites(store, None, worker))


def submit(producers, channel):
    p = producers
    if channel == 'chat':
        chat = p.chats.create(p.project, 'Synthetic conversation')
        return p.chats.send(chat['id'], ChatSend(prompt='Describe a teapot.', mode='chat', client_id='synthetic-chat-0001'))
    if channel == 'agent':
        agent = p.agents.create(p.project, AgentInput(name='Synthetic helper', purpose='Summarize supplied facts.'))
        return p.agents.start(agent['id'], RunInput(instruction='Describe a teapot.', client_id='synthetic-agent-001'))['jobs'][0]
    if channel == 'website':
        run = p.websites.generate(p.project, WebsiteInput(brief='A fictional teapot website', artwork_count=0))
        return p.store.job(run['jobs'][0])
    raise AssertionError(channel)


@pytest.mark.parametrize('channel', CHANNELS)
def test_every_job_producer_persists_immutable_runtime(producers, channel):
    job = submit(producers, channel)
    saved = producers.store.job(job['id'])['request']
    assert saved['runtime_image'] == FIRST
    assert saved['runtime_ref'] == 'synthetic-approved-package'
    assert saved['profile']['package']
    assert saved['prompt'] and len(producers.calls) == 1


@pytest.mark.parametrize('channel,table', [
    ('chat', 'chat_turns'), ('agent', 'agent_runs'), ('website', 'website_runs'),
])
def test_failed_runtime_preparation_rolls_back_job_and_workflow(producers, channel, table):
    def fail(request):
        raise ValueError('Synthetic runtime cannot be identified')
    producers.store.prepare_request = fail
    with pytest.raises(ValueError, match='cannot be identified'):
        submit(producers, channel)
    assert not producers.store.rows('SELECT * FROM jobs')
    assert not producers.store.rows('SELECT * FROM ' + table)


def test_website_retry_preserves_original_runtime_after_switch(producers):
    original = submit(producers, 'website')
    producers.store.status(original['id'], 'failed', 'Synthetic failure')
    producers.websites.tick()
    producers.selected[0] = SECOND
    retry = producers.websites.retry(original['request']['website_run'])
    retried = producers.store.job(retry['jobs'][0])
    assert retried['request']['runtime_image'] == original['request']['runtime_image'] == FIRST
    assert len(producers.calls) == 2


def test_agent_review_step_also_gets_runtime_provenance(producers):
    original = submit(producers, 'agent')
    asset = producers.store.add_asset(producers.project, 'text', 'Synthetic draft', b'A teapot.', '.md', {})
    producers.store.status(original['id'], 'completed', 'Saved', asset=asset['id'])
    producers.agents.tick()
    run = producers.agents.get_run(original['request']['agent_run_id'])
    assert len(run['jobs']) == 2
    assert all(job['request']['runtime_image'] == FIRST for job in run['jobs'])
    assert len(producers.calls) == 2
