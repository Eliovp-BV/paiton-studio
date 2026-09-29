"""Diagnostics endpoints use synthetic logs and cached host facts only."""
import json
import pytest
from fastapi.testclient import TestClient
from studio.app import create_app
from studio.diagnostics import write_job_log, write_setup_log


@pytest.fixture
def fixture(tmp_path, monkeypatch):
    monkeypatch.setattr('studio.app.SystemInfo.snapshot', lambda self: {'platform': {'system': 'Linux'}, 'secret': 'private'})
    monkeypatch.setattr('studio.app.version_info', lambda: {'version': 'fixture', 'git_sha': 'a' * 40, 'path': '/private/source'})
    monkeypatch.setattr('studio.runtime.Runtime.command', lambda *a, **k: pytest.fail('Diagnostics must not launch a process'))
    app = create_app(data=tmp_path, config={}, worker_enabled=False)
    store = app.state.store
    project = store.create_project('Synthetic diagnostics')
    job = store.enqueue(project['id'], {'task': 'write', 'prompt': 'Never export this prompt'})
    with store.connect() as db:
        db.execute('INSERT INTO setup_jobs(id,package,state,message,created,updated) VALUES(?,?,?,?,?,?)',
                   ('setup-fixture', 'qwen38', 'failed', 'Synthetic failure', 1, 1))
    return app, TestClient(app), job


@pytest.mark.parametrize('setup', [False, True])
def test_diagnostics_require_session_and_export_only_sanitized_log(fixture, setup):
    app, client, job = fixture
    identity = 'setup-fixture' if setup else job['id']
    route = '/api/' + ('setup-jobs/' if setup else 'jobs/') + identity + '/diagnostics'
    assert client.get(route).status_code == 401
    client.get('/api/session')
    log = 'No space left on device\nAuthorization: Bearer secret-value\nfile /private/weights/model.bin'
    if setup:
        write_setup_log(app.state.setup, identity, log)
    else:
        write_job_log(app.state.store, identity, log)
    response = client.get(route)
    assert response.status_code == 200
    body = response.json()
    assert body['log']['available'] and 'No space' in body['log']['text']
    assert body['failure']['code'] == 'disk_full'
    assert json.loads(body['copy_text']) == body['diagnostics']
    assert body['diagnostics']['version']['version'] == 'fixture'
    for secret in ('secret-value', '/private/', 'Never export', '"secret"'):
        assert secret not in response.text


@pytest.mark.parametrize('prefix', ['jobs', 'setup-jobs'])
def test_diagnostics_validate_owner_before_read(fixture, prefix):
    app, client, job = fixture
    client.get('/api/session')
    assert client.get(f'/api/{prefix}/missing/diagnostics').status_code == 400


def test_missing_log_is_explicit_and_not_a_server_failure(fixture):
    app, client, job = fixture
    client.get('/api/session')
    body = client.get(f'/api/jobs/{job["id"]}/diagnostics').json()
    assert body['log'] == {'available': False, 'text': '', 'truncated': False}
