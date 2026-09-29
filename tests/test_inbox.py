"""Saved-outcome inbox tests: no runtime, worker, models or network calls."""
from concurrent.futures import ThreadPoolExecutor
import json

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import pytest

from studio.inbox import CompletionInbox
from studio.store import Store, uid


@pytest.fixture
def workspace(tmp_path):
    store = Store(tmp_path)
    first = store.create_project('First project')['id']
    second = store.create_project('Second project')['id']
    return store, CompletionInbox(store), first, second


def job(store, project, task='image', state='completed', updated=100, asset=None, **request):
    identity = uid()
    with store.connect() as db:
        db.execute('INSERT INTO jobs(id,project,request,state,message,asset,created,updated) VALUES(?,?,?,?,?,?,?,?)',
                   (identity, project, json.dumps({'task': task, 'prompt': 'PRIVATE PROMPT', **request}), state,
                    'PRIVATE /host/path exception and secret', asset, 1, updated))
    return identity


def aggregate(store, project, kind, children, state='completed', updated=100):
    identity = uid()
    with store.connect() as db:
        if kind == 'website':
            db.execute('INSERT INTO website_runs VALUES(?,?,?,?,?,?,?,?,?)',
                       (identity, project, state, 'PRIVATE error message', '{}', None, json.dumps(children), 1, updated))
            return identity
        db.executescript('''CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY, project TEXT NOT NULL, definition TEXT NOT NULL, created REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS agent_runs(id TEXT PRIMARY KEY,agent TEXT NOT NULL,client_id TEXT NOT NULL,snapshot TEXT NOT NULL,state TEXT NOT NULL,jobs TEXT NOT NULL,asset TEXT,message TEXT NOT NULL,created REAL NOT NULL,updated REAL NOT NULL);''')
        agent = uid()
        db.execute('INSERT INTO agents VALUES(?,?,?,?)', (agent, project, '{"name":"Review helper"}', 1))
        db.execute('INSERT INTO agent_runs VALUES(?,?,?,?,?,?,?,?,?,?)',
                   (identity, agent, uid(), '{}', state, json.dumps(children), None, 'PRIVATE message', 1, updated))
    return identity


def test_empty_get_is_read_only_and_includes_honest_history_scope(workspace):
    store, inbox, project, _ = workspace
    before = store.rows('SELECT * FROM preferences')
    assert inbox.list() == {'events': [], 'unread': 0, 'has_more': False, 'limit': 100, 'project_id': None}
    assert inbox.list(project)['project_id'] == project
    assert store.rows('SELECT * FROM preferences') == before
    for table in ('jobs', 'job_events', 'inbox_reads'):
        assert store.rows(f'SELECT * FROM {table}') == []


def test_scoped_ordered_recent_history_and_sanitized_targets(workspace):
    store, inbox, project, other = workspace
    asset = store.add_asset(project, 'image', '/private/name.png', b'fixture', '.png', {'token': 'PRIVATE'})
    completed = job(store, project, updated=50, asset=asset['id'])
    failed = job(store, other, task='video', state='failed', updated=75)
    job(store, project, state='running', updated=99)
    value = inbox.list()
    assert [event['state'] for event in value['events']] == ['failed', 'completed']
    assert value['unread'] == 2
    first, second = value['events']
    assert first['target'] == {'kind': 'job', 'job_id': failed, 'project_id': other}
    assert second['target'] == {'kind': 'asset', 'asset_id': asset['id'], 'project_id': project}
    assert second['source_name'] == 'name.png' and 'name.png' in second['summary']
    assert second['id'].startswith('job:' + completed + ':')
    assert 'PRIVATE' not in json.dumps(value) and '/private/' not in json.dumps(value)
    assert inbox.list(project)['events'] == [second]
    with pytest.raises(ValueError, match='Project not found'):
        inbox.list(uid())


def test_cross_project_asset_cannot_be_followed(workspace):
    store, inbox, project, other = workspace
    asset = store.add_asset(other, 'text', 'Other project', b'secret', '.txt', {})
    identity = job(store, project, asset=asset['id'])
    assert inbox.list(project)['events'][0]['target'] == {'kind': 'job', 'job_id': identity, 'project_id': project}


def test_chat_targets_come_from_owned_turn_provenance_not_request_claims(workspace):
    store, inbox, project, other = workspace
    from studio.chat import Chats
    Chats(store, None)
    real, forged = uid(), uid()
    first = job(store, project, task='write', updated=4, chat_id=forged)
    second = job(store, project, task='write', updated=3, chat_id=forged)
    turn = uid()
    with store.connect() as db:
        db.execute('INSERT INTO chats(id,project,title,created,updated) VALUES(?,?,?,?,?)', (real, project, 'Reviewed conversation', 1, 1))
        db.execute('INSERT INTO chats(id,project,title,created,updated) VALUES(?,?,?,?,?)', (forged, other, 'PRIVATE TITLE', 1, 1))
        db.execute('INSERT INTO chat_turns VALUES(?,?,?,?,?,?,?,?)', (turn, real, uid(), 'PRIVATE', 'chat', '[]', first, 1))
        db.execute('INSERT INTO chat_turns VALUES(?,?,?,?,?,?,?,?)', (uid(), forged, uid(), 'PRIVATE', 'chat', '[]', second, 1))
    events = inbox.list(project)['events']
    assert events[0]['target'] == {'kind': 'chat', 'chat_id': real, 'turn_id': turn, 'project_id': project}
    assert events[0]['source_name'] == 'Reviewed conversation'
    assert events[1]['target'] == {'kind': 'job', 'job_id': second, 'project_id': project}
    assert 'PRIVATE' not in json.dumps(events)


@pytest.mark.parametrize('kind', ['agent', 'website'])
def test_aggregate_outcomes_deduplicate_even_legacy_untagged_children(workspace, kind):
    store, inbox, project, _ = workspace
    children = [job(store, project, task='write', updated=10), job(store, project, task='image', updated=20)]
    identity = aggregate(store, project, kind, children, updated=30)
    value = inbox.list(project)
    assert len(value['events']) == 1 and value['unread'] == 1
    event = value['events'][0]
    assert event['target']['run_id'] == identity and event['kind'] == kind
    assert event['state'] == ('needs_attention' if kind == 'website' else 'completed')
    if kind == 'agent':
        assert event['source_name'] == 'Review helper' and 'Review helper' in event['summary']
    assert 'PRIVATE' not in json.dumps(value)


@pytest.mark.parametrize('kind,state', [('agent', 'reviewing'), ('website', 'artwork')])
def test_running_aggregates_do_not_notify_for_completed_steps(workspace, kind, state):
    store, inbox, project, _ = workspace
    aggregate(store, project, kind, [job(store, project)], state=state)
    assert inbox.list()['events'] == []


def test_source_names_are_bounded_plain_labels_and_agent_run_names_are_historical(workspace):
    store, inbox, project, _ = workspace
    identity = aggregate(store, project, 'agent', [])
    with store.connect() as db:
        db.execute('UPDATE agent_runs SET snapshot=? WHERE id=?',
                   (json.dumps({'definition': {'name': 'Welcome writer\n' + 'x' * 150}}), identity))
        db.execute('UPDATE agents SET definition=?', ('{"name":"Renamed agent"}',))
    event = inbox.list()['events'][0]
    assert event['source_name'].startswith('Welcome writer')
    assert len(event['source_name']) == 120 and '\n' not in event['source_name']
    assert 'Renamed agent' not in event['summary']


@pytest.mark.parametrize('field,value', [
    ('model_api', True), ('mcp_request_id', 'external-request'), ('mail_draft_id', 'external-draft'),
    ('agent_run_id', 'missing-aggregate'), ('website_run', 'missing-aggregate'),
    ('internal', True), ('service', True), ('hidden', True),
])
def test_internal_or_external_service_jobs_are_excluded(workspace, field, value):
    store, inbox, project, _ = workspace
    job(store, project, **{field: value})
    assert inbox.list()['events'] == []


def test_external_request_table_also_excludes_legacy_untagged_jobs(workspace):
    store, inbox, project, _ = workspace
    for table in ('model_api_requests', 'mcp_requests'):
        identity = job(store, project)
        with store.connect() as db:
            db.execute(f'CREATE TABLE {table}(job TEXT)')
            db.execute(f'INSERT INTO {table} VALUES(?)', (identity,))
    job(store, project, task='internal-service')
    assert inbox.list()['events'] == []


def test_read_is_persistent_idempotent_and_cannot_ack_later_outcomes(workspace):
    store, inbox, project, _ = workspace
    identity = job(store, project, state='failed')
    event = inbox.list()['events'][0]['id']
    assert inbox.mark_read({'event_ids': [event, event]}) == {'read_ids': [event], 'unavailable_ids': []}
    recreated = CompletionInbox(Store(store.root))
    assert recreated.list()['unread'] == 0
    recreated.mark_read({'event_ids': [event]})
    assert len(store.rows('SELECT * FROM inbox_reads')) == 1
    store.status(identity, 'completed', 'Saved later')
    latest = inbox.list()['events'][0]
    assert latest['id'] != event and not latest['read']
    assert inbox.mark_read({'event_ids': [event]}) == {'read_ids': [], 'unavailable_ids': [event]}
    assert inbox.list()['unread'] == 1


def test_mark_visible_batch_never_marks_newer_or_other_project_results(workspace):
    store, inbox, project, other = workspace
    job(store, project, updated=100)
    selected = inbox.list(project)['events'][0]['id']
    job(store, project, updated=101)
    job(store, other, updated=102)
    inbox.mark_read({'event_ids': [selected]})
    assert inbox.list()['unread'] == 2
    assert inbox.list(project)['unread'] == 1


def test_read_concurrency_preserves_all_acknowledgments(workspace):
    store, inbox, project, _ = workspace
    for index in range(5):
        job(store, project, updated=index)
    identities = [event['id'] for event in inbox.list()['events']]
    def mark(identity):
        return CompletionInbox(store).mark_read({'event_ids': [identity]})
    with ThreadPoolExecutor(max_workers=5) as pool:
        results = list(pool.map(mark, identities * 2))
    assert all(len(result['read_ids']) == 1 for result in results)
    assert inbox.list()['unread'] == 0
    assert len(store.rows('SELECT * FROM inbox_reads')) == 5


def test_window_is_bounded_and_scoped_unread_is_honest(workspace):
    store, inbox, project, other = workspace
    for index in range(105):
        job(store, project, updated=index)
    job(store, other, updated=106)
    result = inbox.list()
    assert len(result['events']) == result['unread'] == 100 and result['has_more']
    limited = inbox.list(project, limit=3)
    assert [event['updated'] for event in limited['events']] == [104, 103, 102]
    assert limited['unread'] == 3 and limited['has_more']
    # A reviewed event remains acknowledgeable after it falls outside the window.
    prior = inbox.list(project)['events'][-1]['id']
    for index in range(110, 215):
        job(store, project, updated=index)
    assert inbox.mark_read({'event_ids': [prior]})['read_ids'] == [prior]


def test_ack_does_not_change_job_history_or_schedule_work(workspace):
    store, inbox, project, _ = workspace
    job(store, project)
    before = store.rows('SELECT * FROM jobs')
    inbox.mark_read({'event_ids': [inbox.list()['events'][0]['id']]})
    assert store.rows('SELECT * FROM jobs') == before
    assert not store.rows('SELECT * FROM job_events')


def test_router_validates_ids_and_bounds_without_runtime(workspace):
    store, inbox, project, _ = workspace
    job(store, project)
    app = FastAPI()
    app.include_router(inbox.router())
    browser = TestClient(app)
    assert browser.get('/api/inbox', params={'project_id': project}).status_code == 200
    for query in ('limit=0', 'limit=101', 'project_id=../bad'):
        assert browser.get('/api/inbox?' + query).status_code == 422
    for body in ({'event_ids': []}, {'event_ids': ['unknown']}, {'event_ids': ['bad'] * 101},
                 {'event_ids': ['bad'], 'all': True}):
        assert browser.post('/api/inbox/read', json=body).status_code == 422
    identity = browser.get('/api/inbox').json()['events'][0]['id']
    assert browser.post('/api/inbox/read', json={'event_ids': [identity]}).json()['read_ids'] == [identity]
    assert browser.get('/api/inbox').json()['unread'] == 0
