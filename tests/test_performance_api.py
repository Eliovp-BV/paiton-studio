"""Performance payloads use explicit synthetic receipts, never inference."""
import json

from fastapi.testclient import TestClient

from studio.app import create_app
from studio.chat import Chats
from studio.registry import profile
from studio.store import uid


def fixture(tmp_path):
    app = create_app(data=tmp_path, config={}, worker_enabled=False)
    store = app.state.store
    project = store.create_project('Performance fixture')
    request = dict(task='write', profile=profile('gptoss-chat', 'write'),
                   runtime_image='sha256:' + 'a' * 64, prompt='Synthetic request')
    client = TestClient(app)
    client.get('/api/session')
    return app, store, project, request, client


def completed(store, project, request, seconds, performance=None):
    job = store.enqueue(project['id'], request)
    metadata = dict(job=job['id'], origin='generated', request=request, generation_seconds=seconds)
    if performance is not None:
        metadata['performance'] = performance
    asset = store.add_asset(project['id'], 'text', 'Synthetic reply', b'Fixture reply', '.md', metadata)
    store.status(job['id'], 'completed', 'Saved fixture', asset=asset['id'])
    return job, asset


def test_status_reports_measured_result_and_matching_median(tmp_path):
    app, store, project, request, client = fixture(tmp_path)
    metrics = dict(output_tokens=32, first_token_seconds=.5, output_seconds=4,
                   request_seconds=4.5, rate_scope='client_observed_stream', model_state='warm')
    first, _ = completed(store, project, request, 10, metrics)
    completed(store, project, request, 30)
    pending = store.enqueue(project['id'], request)
    response = client.get('/api/status?compact=true')
    assert response.status_code == 200
    jobs = {item['id']: item for item in response.json()['jobs']}
    assert jobs[first['id']]['performance']['tokens_per_second'] == 8
    assert jobs[first['id']]['performance']['first_token_seconds'] == .5
    assert jobs[pending['id']]['estimate'] == dict(seconds=20, samples=2, scope='same_contract_median')
    different = store.enqueue(project['id'], {**request, 'runtime_image': 'sha256:' + 'b' * 64})
    jobs = {item['id']: item for item in client.get('/api/status').json()['jobs']}
    assert not jobs[different['id']].get('estimate')


def test_chat_poll_preserves_metrics_and_estimates(tmp_path):
    app, store, project, request, client = fixture(tmp_path)
    chats = Chats(store, None)
    chat = chats.create(project['id'], 'Performance conversation')
    finished, asset = completed(store, project, request, 12, dict(output_tokens=9))
    pending = store.enqueue(project['id'], request)
    with store.connect() as db:
        for number, job in enumerate((finished, pending)):
            db.execute('INSERT INTO chat_turns(id,chat,client_id,prompt,mode,documents,job,created) VALUES(?,?,?,?,?,?,?,?)',
                       (uid(), chat['id'], f'fixture-{number}', 'Synthetic request', 'chat', json.dumps([]), job['id'], number + 1))
    response = client.get('/api/chats/' + chat['id'] + '?compact=true')
    assert response.status_code == 200
    turns = response.json()['turns']
    assert turns[0]['asset']['metadata']['performance']['output_tokens'] == 9
    assert turns[1]['job']['estimate']['seconds'] == 12
    assert turns[1]['job']['estimate']['samples'] == 1
