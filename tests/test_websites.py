import io
import json
import zipfile

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from studio.app import create_app
from studio.preferences import get_settings, resolve_profile
from studio.queue import Worker
from studio.runtime import Runtime
from studio.store import Store
from studio.websites import Websites, WebsiteInput, export_website


@pytest.fixture
def workflow(tmp_path, monkeypatch):
    monkeypatch.setattr(Runtime, 'preflight', lambda self, request: 'installed-test-package')
    store = Store(tmp_path)
    runtime = Runtime(store, {})
    worker = Worker(store, runtime)
    return Websites(store, runtime, worker), store.create_project()['id']


def plan(pages=2):
    return {'title': 'Test site', 'pages': [
        {'slug': 'index' if i == 0 else f'page-{i}', 'title': f'Page {i}', 'description': 'Intro',
         'sections': [{'heading': '<script>unsafe()</script>', 'body': 'Approved fictional copy', 'image_prompt': 'A forest'}]}
        for i in range(pages)]}


def complete(work, run, position, content, kind='text'):
    job = work.store.job(run['jobs'][position])
    asset = work.store.add_asset(run['project'], kind, 'Test fixture', content,
                                 '.md' if kind == 'text' else '.png', {'job': job['id']})
    work.store.status(job['id'], 'completed', 'CPU fixture completion', asset=asset['id'])
    return asset


def test_website_durable_stages_apply_and_offline_links(workflow):
    work, project = workflow
    run = work.generate(project, WebsiteInput(brief='Create a fictional forest website', page_count=2, artwork_count=2))
    assert work.store.job(run['jobs'][0])['request']['profile']['package'] == 'qwen38-mxfp4'
    assert work.store.job(run['jobs'][0])['request']['messages'][0]['role'] == 'system'
    complete(work, run, 0, json.dumps(plan()).encode())
    work.tick()
    work.tick()
    run = work.get_run(run['id'])
    assert run['state'] == 'artwork' and len(run['jobs']) == 3
    image = io.BytesIO(); Image.new('RGB', (8, 8)).save(image, format='PNG')
    for index in (1, 2):
        complete(work, run, index, image.getvalue(), 'image')
    restarted = Websites(work.store, work.runtime, work.worker)
    restarted.tick()
    assert restarted.get_run(run['id'])['state'] == 'completed'
    assert restarted.site(project) is None
    site = restarted.apply(run['id'], 0)
    assert site['revision'] == 1
    assert restarted.get_run(run['id'])['state'] == 'applied'
    with pytest.raises(ValueError, match='another window'):
        restarted.save(project, {**site, 'revision': 0})
    path = export_website(work.store, project, site)
    with zipfile.ZipFile(path) as archive:
        home = archive.read('index.html').decode()
        assert 'href="page-1.html"' in home
        assert 'href="index.html"' in archive.read('page-1.html').decode()
        assert '&lt;script&gt;' in home and '<script>' not in home
        assert len([name for name in archive.namelist() if name.startswith('assets/')]) == 2
        assert 'https://' not in home


@pytest.mark.parametrize('bad', [None, 'string', 12, []])
def test_malformed_model_plan_fails_without_killing_worker(workflow, bad):
    work, project = workflow
    run = work.generate(project, WebsiteInput(brief='Fictional website about woods', page_count=2, artwork_count=0))
    content = plan(); content['pages'][0]['sections'] = [bad]
    complete(work, run, 0, json.dumps(content).encode())
    work.tick()
    assert work.get_run(run['id'])['state'] == 'failed'
    assert work.site(project) is None


def test_failure_cancels_remaining_artwork_and_cancel_preserves_assets(workflow):
    work, project = workflow
    run = work.generate(project, WebsiteInput(brief='Fictional website about woods', page_count=2, artwork_count=2))
    original = complete(work, run, 0, json.dumps(plan()).encode())
    work.tick(); run = work.get_run(run['id'])
    work.store.status(run['jobs'][1], 'failed', 'Fixture failure')
    work.tick()
    assert work.store.job(run['jobs'][2])['state'] == 'cancelled'
    assert work.get_run(run['id'])['state'] == 'failed'
    assert work.store.file(original).is_file()
    next_run = work.generate(project, WebsiteInput(brief='Fictional website about woods', artwork_count=0))
    work.cancel(next_run['id'])
    assert work.store.job(next_run['jobs'][0])['state'] == 'cancelled'


def test_settings_persist_filter_roles_and_new_user_auto_error(tmp_path, monkeypatch):
    app = create_app(tmp_path, config={}, worker_enabled=False)
    with TestClient(app) as client:
        client.headers['X-Studio-Token'] = client.get('/api/session').json()['token']
        assert client.put('/api/settings', json={'defaults': {'video': 'qwen38-writing'}}).status_code == 400
        assert client.put('/api/settings', json={'defaults': {'write': 'qwen38-writing'}, 'generation': {'seed': 50}}).status_code == 200
        assert get_settings(Store(tmp_path))['defaults']['write'] == 'qwen38-writing'
        assert client.get('/api/settings').json()['storage']['free_bytes'] > 0
        project = client.post('/api/projects', json={}).json()['id']
        assert client.post(f'/api/projects/{project}/jobs', json={'task':'video','profile_id':'qwen38-writing','prompt':'test'}).status_code == 400
        assert client.post(f'/api/projects/{project}/jobs', json={'task':'write','profile_id':'qwen38-website','prompt':'test'}).status_code == 400
        assert client.post(f'/api/projects/{project}/jobs', json={'task':'image','prompt':'test'}).status_code == 400
        assert client.post(f'/api/projects/{project}/website/generate', json={'brief':'Make a forest website','page_count':8}).status_code == 422


def test_website_asset_scope_and_path_validation(workflow):
    work, project = workflow
    second = work.store.create_project()['id']
    foreign = work.store.add_asset(second, 'image', 'Foreign', b'fixture', '.png', {})
    site = {'title': 'A', 'theme': 'light', 'pages': [
        {'slug': 'index', 'title': 'Home', 'sections': [{'body': 'Copy', 'asset_ids': [foreign['id']]}]},
        {'slug': 'about', 'title': 'About', 'sections': [{'body': 'Copy'}]}]}
    with pytest.raises(ValueError): work.save(project, site)
    site['pages'][0]['sections'][0]['asset_ids'] = []
    site['pages'][1]['slug'] = '../escape'
    with pytest.raises(ValueError): work.save(project, site)


def test_full_project_export_contains_website_and_original_revisions(workflow):
    from studio.export import export_project
    work, project = workflow
    run = work.generate(project, WebsiteInput(brief='A fictional woodland portfolio', page_count=2, artwork_count=0))
    complete(work, run, 0, json.dumps(plan()).encode())
    work.tick(); site = work.apply(run['id'], 0)
    with zipfile.ZipFile(export_project(work.store, project)) as archive:
        manifest = json.loads(archive.read('project.json'))
        assert manifest['website']['title'] == site['title']
        assert 'website/index.html' in archive.namelist()
        assert 'website/page-1.html' in archive.namelist()
        assert any(name.endswith('.md') for name in archive.namelist())


def test_stale_apply_does_not_overwrite_newer_edits(workflow):
    work, project = workflow
    run = work.generate(project, WebsiteInput(brief='A fictional woodland portfolio', page_count=2, artwork_count=0))
    complete(work, run, 0, json.dumps(plan()).encode())
    work.tick()
    work.save(project, {'title': 'Saved elsewhere', 'pages': [
        {'slug': 'index', 'title': 'Home', 'sections': [{'body': 'Existing'}]},
        {'slug': 'about', 'title': 'About', 'sections': [{'body': 'Existing'}]}]})
    with pytest.raises(ValueError, match='another window'):
        work.apply(run['id'], 0)
    assert work.site(project)['title'] == 'Saved elsewhere'


def test_missing_explicit_default_has_actionable_api_error(tmp_path):
    app = create_app(tmp_path, config={}, worker_enabled=False)
    with TestClient(app) as client:
        client.headers['X-Studio-Token'] = client.get('/api/session').json()['token']
        client.put('/api/settings', json={'defaults': {'write': 'qwen38-writing'}})
        project = client.post('/api/projects', json={}).json()['id']
        response = client.post(f'/api/projects/{project}/jobs', json={'task': 'write', 'prompt': 'A story'})
        assert response.status_code == 400
        assert 'runtime image' in response.json()['error']


def test_website_child_retry_cannot_become_an_orphan_job(tmp_path):
    app = create_app(tmp_path, config={}, worker_enabled=False)
    store = app.state.store
    p = store.create_project()['id']
    job = store.enqueue(p, {'website_run': 'parent-run', 'task': 'write'})
    store.status(job['id'], 'failed', 'Fixture')
    with TestClient(app) as client:
        client.headers['X-Studio-Token'] = client.get('/api/session').json()['token']
        response = client.post('/api/jobs/'+job['id']+'/retry', json={})
        assert response.status_code == 400 and 'Build Page' in response.json()['error']
        assert len(store.rows('SELECT id FROM jobs')) == 1
