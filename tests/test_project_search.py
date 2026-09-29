"""Search saved, allowlisted project text without tools, model readiness or writes."""
import json
import os
from pathlib import Path
import subprocess
import time

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
import pytest

from studio import project_search
from studio.agents import Agents
from studio.chat import Chats
from studio.coding import CodingWorkspace
from studio.project_search import ProjectSearch
from studio.store import Store, uid


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    store = Store(tmp_path / 'data')
    project = store.create_project('Search project')['id']
    other = store.create_project('Other project')['id']
    chats = Chats(store, None)
    Agents(store, None, None, chats)
    monkeypatch.setattr(subprocess, 'run', lambda *args, **kwargs: pytest.fail('Search must not run a process.'))
    monkeypatch.setattr('studio.chat.resolve_profile', lambda *args: pytest.fail('Search must not inspect a model.'))
    return store, project, other, ProjectSearch(store)


def text_asset(store, project, text, name='Saved text'):
    return store.add_asset(project, 'text', name, text.encode(), '.txt', {})


def chat_turn(store, project, prompt, answer=None, state='completed', archived=False):
    chat = Chats(store, None).create(project, 'A saved discussion')
    identity = uid()
    job = store.enqueue(project, {'task': 'write', 'chat_id': chat['id'], 'runtime_secret': 'DO_NOT_EXPOSE_INTERNAL_METADATA'})
    asset = text_asset(store, project, answer) if answer else None
    store.status(job['id'], state, 'Synthetic saved state', asset=asset['id'] if asset else None)
    with store.connect() as db:
        db.execute('UPDATE chats SET archived=? WHERE id=?', (archived, chat['id']))
        db.execute('INSERT INTO chat_turns VALUES(?,?,?,?,?,?,?,?)', (identity, chat['id'], uid(), prompt, 'chat', '[]', job['id'], time.time()))
    return chat['id'], identity, asset


def agent_run(store, project, content, state='completed'):
    agent, run = uid(), uid()
    asset = text_asset(store, project, content)
    job = store.enqueue(project, {'task': 'write', 'agent_run_id': run})
    store.status(job['id'], 'completed', 'Synthetic output', asset=asset['id'])
    with store.connect() as db:
        db.execute('INSERT INTO agents VALUES(?,?,?,?)', (agent, project, json.dumps({'name': 'Research helper'}), time.time()))
        db.execute('INSERT INTO agent_runs VALUES(?,?,?,?,?,?,?,?,?,?)', (run, agent, uid(), '{}', state, json.dumps([job['id']]), asset['id'], 'Saved fixture', time.time(), time.time()))
    return agent, run


def test_saved_content_returns_exact_project_targets_archives_and_literal_snippets(workspace):
    store, project, other, search = workspace
    chat, turn, _ = chat_turn(store, project, 'Find needle.* in this question.', '😀 The NEEDLE.* reply.', archived=True)
    agent, run = agent_run(store, project, 'Agent needle.* result.')
    extracted = text_asset(store, project, 'Document needle.* excerpt.', 'Extracted text')
    document = store.add_asset(project, 'document', 'Facts.pdf', b'fake binary', '.pdf', {'extracted_text': extracted['id']})
    image = store.add_asset(project, 'image', 'Art', b'fake image', '.png', {'request': {'prompt': 'needle.* scene', 'profile': {'model': 'Local fixture'}, 'token': 'DO_NOT_EXPOSE_INTERNAL_METADATA'}})
    code = CodingWorkspace(store).write(project, 'src/main.py', '# first\nprint("needle.*")\n')
    chat_turn(store, other, 'Other project needle.*', 'PRIVATE CROSS PROJECT')
    before = store.rows('SELECT id,state FROM jobs')
    result = search.search(project, 'needle.*')
    assert {row['source'] for row in result['results']} == {'chat', 'agent', 'document', 'asset', 'code'}
    assert not result['partial']
    answers = [row for row in result['results'] if row['field'] == 'reply']
    assert answers[0]['target'] == {'kind': 'chat', 'chat_id': chat, 'turn_id': turn, 'query': 'needle.*'}
    assert answers[0]['archived'] is True
    encoded = answers[0]['snippet'].encode('utf-16-le')
    start, end = answers[0]['highlights'][0]
    assert encoded[start * 2:end * 2].decode('utf-16-le') == 'NEEDLE.*'
    assert next(row for row in result['results'] if row['source'] == 'agent')['target'] == {'kind': 'agent', 'agent_id': agent, 'run_id': run, 'query': 'needle.*'}
    assert [row['target']['asset_id'] for row in result['results'] if row['source'] == 'document'] == [document['id']]
    assert next(row for row in result['results'] if row['source'] == 'asset')['target']['asset_id'] == image['id']
    assert next(row for row in result['results'] if row['source'] == 'code')['target'] == {'kind': 'code', 'path': code['path'], 'version': code['version'], 'line': 2, 'query': 'needle.*'}
    assert 'PRIVATE CROSS PROJECT' not in json.dumps(result)
    assert search.search(project, 'DO_NOT_EXPOSE_INTERNAL_METADATA')['results'] == []
    assert store.rows('SELECT id,state FROM jobs') == before


def test_pending_chat_and_agent_text_is_not_exposed_as_an_ordinary_document(workspace):
    store, project, other, search = workspace
    chat_turn(store, project, 'Saved pending question', 'UNFINISHED_REPLY', state='generating')
    agent_run(store, project, 'UNFINISHED_AGENT', state='reviewing')
    assert search.search(project, 'UNFINISHED')['results'] == []
    assert search.search(project, 'Saved pending question')['results'][0]['source'] == 'chat'


def test_only_user_facing_string_metadata_is_searchable(workspace):
    store, project, other, search = workspace
    store.add_asset(project, 'image', 'A local image', b'image fixture', '.png', {
        'prompt': {'credentials': 'PRIVATE_STRUCTURED_CANARY'},
        'model': {'token': 'PRIVATE_STRUCTURED_CANARY'},
        'request': {'prompt': {'token': 'PRIVATE_STRUCTURED_CANARY'},
                    'runtime_ref': 'PRIVATE_RUNTIME_CANARY', 'headers': {'Authorization': 'PRIVATE_RUNTIME_CANARY'},
                    'profile': {'model': 'Visible model name'}}})
    assert search.search(project, 'PRIVATE_')['results'] == []
    assert search.search(project, 'Visible model')['results'][0]['field'] == 'model'


@pytest.mark.parametrize('scenario', ['outside', 'other_project', 'symlink', 'parent_link', 'hardlink', 'modified'])
def test_text_reads_reject_unmanaged_paths_links_and_modified_snapshots(workspace, tmp_path, scenario):
    store, project, other, search = workspace
    asset = text_asset(store, project, 'ORIGINAL content')
    original = store.file(asset)
    secret = tmp_path / 'private.txt'
    secret.write_text('PRIVATE_CANARY')
    if scenario == 'outside':
        with store.connect() as db:
            db.execute('UPDATE assets SET path=? WHERE id=?', (str(secret), asset['id']))
    elif scenario == 'other_project':
        foreign = text_asset(store, other, 'PRIVATE_CANARY')
        with store.connect() as db:
            db.execute('UPDATE assets SET path=? WHERE id=?', (foreign['path'], asset['id']))
    elif scenario == 'parent_link':
        moved = original.parent.with_name('saved-assets')
        original.parent.rename(moved)
        original.parent.symlink_to(moved, target_is_directory=True)
    elif scenario in ('symlink', 'hardlink'):
        original.unlink()
        original.symlink_to(secret) if scenario == 'symlink' else os.link(secret, original)
    else:
        original.write_text('PRIVATE_CANARY')
    value = search.search(project, 'PRIVATE_CANARY')
    assert value['results'] == [] and value['partial']
    assert sum(value['skipped'].values()) >= 1
    assert 'PRIVATE_CANARY' not in json.dumps(value['results'])


def test_managed_code_ignores_private_files_and_detects_revision_changes(workspace, monkeypatch):
    store, project, other, search = workspace
    coding = CodingWorkspace(store)
    coding.write(project, 'main.py', 'public needle\n')
    root = Path(coding.snapshot(project)['root'])
    (root / '.env').write_text('PRIVATE_CANARY')
    (root / 'credentials.json').write_text('PRIVATE_CANARY')
    assert search.search(project, 'PRIVATE_CANARY')['results'] == []
    snapshot = search.coding.snapshot
    def changing(identity):
        value = snapshot(identity)
        (root / 'main.py').write_text('changed needle\n')
        return value
    monkeypatch.setattr(search.coding, 'snapshot', changing)
    value = search.search(project, 'needle')
    assert value['results'] == [] and value['skipped']['changed'] == 1


def test_explicit_result_field_item_and_byte_limits_are_truthful(workspace, monkeypatch):
    store, project, other, search = workspace
    text_asset(store, project, 'needle ' * 10)
    value = search.search(project, 'needle')
    assert len(value['results']) == 3 and 'field_match_limit' in value['partial_reasons']
    monkeypatch.setattr(project_search, 'MAX_RESULTS', 2)
    value = search.search(project, 'needle')
    assert len(value['results']) == 2 and value['limit_reached']
    monkeypatch.setattr(project_search, 'MAX_TEXT_BYTES', 10)
    value = search.search(project, 'needle')
    assert 'text_limit' in value['partial_reasons'] and value['searched_bytes'] <= 10
    monkeypatch.setattr(project_search, 'MAX_TEXT_BYTES', 10000)
    monkeypatch.setattr(project_search, 'MAX_CATEGORY_ITEMS', 1)
    text_asset(store, project, 'different text')
    value = search.search(project, 'absent')
    assert 'item_limit' in value['partial_reasons'] and value['searched']['document'] == 1


def test_missing_and_oversize_text_is_reported_without_prefix_results(workspace, monkeypatch):
    store, project, other, search = workspace
    missing = text_asset(store, project, 'needle missing')
    store.file(missing).unlink()
    text_asset(store, project, 'needle ' * 100)
    monkeypatch.setattr(project_search, 'MAX_ASSET_BYTES', 100)
    value = search.search(project, 'needle')
    assert value['results'] == [] and value['partial']
    assert value['skipped']['unreadable'] == 1 and value['skipped']['oversized'] == 1


def test_router_validates_literal_query_and_no_models_are_required(workspace):
    store, project, other, search = workspace
    app = FastAPI()
    app.include_router(search.router())
    @app.exception_handler(ValueError)
    async def invalid(request, error):
        return JSONResponse({'detail': str(error)}, 400)
    client = TestClient(app)
    base = f'/api/projects/{project}/search'
    assert client.get(base, params={'q': 'plain'}).json()['results'] == []
    for query in ['', 'x' * 201, '   ', 'a\nb']:
        assert client.get(base, params={'q': query}).status_code in (400, 422)
    assert client.get('/api/projects/invalid/search', params={'q': 'needle'}).status_code == 400
    assert client.get(f'/api/projects/{uid()}/search', params={'q': 'needle'}).status_code == 400
