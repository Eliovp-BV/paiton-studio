import sqlite3
from concurrent.futures import ThreadPoolExecutor

from fastapi.testclient import TestClient

from studio.app import create_app
from studio.store import Store, ProjectConflict


def test_migrate_existing_project_without_losing_draft(tmp_path):
    with sqlite3.connect(tmp_path / 'studio.sqlite') as db:
        db.execute('CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,state TEXT,updated REAL)')
        db.execute('INSERT INTO projects VALUES(?,?,?,?)', ('original', 'Original', '{"write":{"prompt":"My draft"}}', 1))
    store = Store(tmp_path)
    project = store.project('original')
    assert project['revision'] == 0 and project['state']['write']['prompt'] == 'My draft'
    assert Store(tmp_path).project('original') == project


def test_two_lan_windows_cannot_overwrite_each_other(tmp_path):
    with TestClient(create_app(tmp_path, worker_enabled=False)) as client:
        token = client.get('/api/session').json()['token']
        client.headers['x-studio-token'] = token
        project = client.post('/api/projects').json()
        path = '/api/projects/' + project['id']
        first = client.put(path, json={'name':'Window one','state':{'write':{'prompt':'Keep this'}}, 'revision':project['revision']})
        assert first.status_code == 200 and first.json()['revision'] == 1
        second = client.put(path, json={'name':'Window two','state':{}, 'revision':project['revision']})
        assert second.status_code == 409
        assert client.get(path).json()['state']['write']['prompt'] == 'Keep this'
        assert client.put(path, json={'name':'Old client','state':{}}).status_code == 422


def test_compare_and_swap_is_atomic_across_writers(tmp_path):
    store = Store(tmp_path)
    project = store.create_project()
    def save(name):
        try: return store.update_project(project['id'], name, {}, 0)['name']
        except ProjectConflict: return None
    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(save, ['A','B']))
    assert sum(r is not None for r in results) == 1
    assert store.project(project['id'])['revision'] == 1
