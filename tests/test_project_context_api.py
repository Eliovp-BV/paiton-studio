"""Owner-only context inspection works with model execution unavailable."""
import io
import json
import zipfile

from fastapi.testclient import TestClient
import pytest

from studio.app import create_app
from studio.runtime import Runtime


@pytest.fixture
def client(tmp_path, monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail('Context inspection must not prepare or execute model work')
    monkeypatch.setattr(Runtime, 'preflight', forbidden)
    monkeypatch.setattr(Runtime, 'pin_request', forbidden)
    monkeypatch.setattr('studio.chat.resolve_profile', forbidden)
    monkeypatch.setattr('studio.agents.resolve_profile', forbidden)
    app = create_app(tmp_path, config={}, worker_enabled=False)
    with TestClient(app) as c:
        c.headers['X-Studio-Token'] = c.get('/api/session').json()['token']
        c.store = app.state.store
        yield c


def project(client, name):
    response = client.post('/api/projects', json={'name': name})
    assert response.status_code == 200, response.text
    return response.json()['id']


def test_brief_versions_are_scoped_guarded_and_preserved_in_project_export(client):
    first, second = project(client, 'First'), project(client, 'Second')
    endpoint = f'/api/projects/{first}/brief'
    initial = client.get(endpoint).json()
    assert initial['content'] == '' and initial['revision'] == 0
    payload = {'content': 'Audience: beginners. Use metric units.', 'expected_revision': 0}
    assert client.put(endpoint, json=payload, headers={'X-Studio-Token': ''}).status_code == 403
    assert client.put(endpoint, json=payload, headers={'Origin': 'https://untrusted.example'}).status_code == 403
    saved = client.put(endpoint, json=payload)
    assert saved.status_code == 200
    assert saved.json()['revision'] == 1
    assert client.put(endpoint, json={**payload, 'content': 'Stale overwrite'}).status_code == 409
    assert client.get(endpoint).json()['content'] == payload['content']
    assert client.get(f'/api/projects/{second}/brief').json()['content'] == ''
    exported = client.post(f'/api/projects/{first}/export', json={})
    assert exported.status_code == 200, exported.text
    with zipfile.ZipFile(io.BytesIO(exported.content)) as archive:
        assert archive.read('project-brief.md').decode() == payload['content']
        manifest = json.loads(archive.read('project.json'))
        assert manifest['project_brief']['revision'] == 1
        assert manifest['project_brief']['content'] == payload['content']


def test_new_and_existing_chat_previews_do_not_create_work_or_load_models(client):
    identity = project(client, 'Context project')
    other = project(client, 'Other project')
    client.put(f'/api/projects/{identity}/brief', json={'content': 'Public transport guide for students.', 'expected_revision': 0}).raise_for_status()
    client.put(f'/api/projects/{other}/brief', json={'content': 'Unrelated private plan.', 'expected_revision': 0}).raise_for_status()
    request = {'prompt': 'Draft an introduction.', 'mode': 'chat', 'client_id': 'context-preview-00000000', 'project_brief_revision': 1}
    endpoint = f'/api/projects/{identity}/chat-context'
    assert client.post(endpoint, json=request, headers={'X-Studio-Token': ''}).status_code == 403
    preview = client.post(endpoint, json=request)
    assert preview.status_code == 200, preview.text
    data = preview.json()
    assert data['kind'] == 'text' and len(data['fingerprint']) == 64
    joined = '\n'.join(message['content'] for message in data['messages'])
    assert 'Public transport guide for students.' in joined
    assert 'Unrelated private plan.' not in joined
    assert data['project_brief']['revision'] == 1
    assert client.store.rows('SELECT id FROM jobs') == []
    assert client.store.rows('SELECT id FROM chats') == []
    without_nonce = {key: value for key, value in request.items() if key != 'client_id'}
    assert client.post(endpoint, json=without_nonce).json()['fingerprint'] == data['fingerprint']
    assert client.post(endpoint, json={**request, 'project_brief_revision': 0}).status_code == 409
    chat = client.post(f'/api/projects/{identity}/chats', json={}).json()
    inspected = client.post(f'/api/chats/{chat["id"]}/context', json=request)
    assert inspected.status_code == 200, inspected.text
    assert inspected.json()['messages'] == data['messages']
    assert client.store.rows('SELECT id FROM jobs') == []
    assert client.store.rows('SELECT id FROM chat_turns') == []
    assert client.post(f'/api/chats/{chat["id"]}/messages', json=without_nonce).status_code == 422
    assert client.get('/api/status').json()['worker']['state'] == 'stopped'


def test_agent_preview_uses_selected_context_and_does_not_start_a_run(client):
    identity = project(client, 'Agent project')
    client.put(f'/api/projects/{identity}/brief', json={'content': 'Use concise language for new employees.', 'expected_revision': 0}).raise_for_status()
    agent = client.post(f'/api/projects/{identity}/agents', json={'name': 'Guide', 'purpose': 'Write onboarding notes.', 'template': 'custom'}).json()
    endpoint = f'/api/agents/{agent["id"]}/context'
    body = {'instruction': 'Explain the first day.', 'client_id': 'context-preview-00000000', 'project_brief_revision': 1}
    assert client.post(endpoint, json=body, headers={'X-Studio-Token': ''}).status_code == 403
    preview = client.post(endpoint, json=body)
    assert preview.status_code == 200, preview.text
    data = preview.json()
    text = '\n'.join(message['content'] for message in data['messages'])
    assert 'Write onboarding notes.' in text and 'Use concise language for new employees.' in text
    assert data['project_brief']['revision'] == 1
    assert client.store.rows('SELECT id FROM jobs') == []
    assert client.store.rows('SELECT id FROM agent_runs') == []
    without_nonce = {key: value for key, value in body.items() if key != 'client_id'}
    assert client.post(endpoint, json=without_nonce).json()['fingerprint'] == data['fingerprint']
    assert client.post(f'/api/agents/{agent["id"]}/runs', json=without_nonce).status_code == 422
    excluded = client.post(endpoint, json={**body, 'project_brief_revision': None}).json()
    assert excluded['project_brief'] is None
    assert 'Use concise language for new employees.' not in json.dumps(excluded)
