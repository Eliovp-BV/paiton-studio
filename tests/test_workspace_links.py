"""Authenticated result handoffs and metadata routes without runtime execution."""
import json
import os
from pathlib import Path
from types import SimpleNamespace

from fastapi.testclient import TestClient
import pytest

from studio.agents import Agents
from studio.app import create_app
from studio.coding import CodeFileAccess
from studio.queue import Worker
from studio.runtime import Runtime
from studio.store import Store, uid
from studio.websites import Websites


@pytest.fixture
def work(tmp_path, monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail('Workspace links must never prepare, load, execute or enqueue model work.')
    for method in ('preflight', 'pin_request', 'start', 'run', 'stream', 'http', 'command'):
        monkeypatch.setattr(Runtime, method, forbidden)
    monkeypatch.setattr(Worker, 'start', forbidden)
    monkeypatch.setattr(Store, 'enqueue', forbidden)
    monkeypatch.setattr(Agents, '_enqueue', forbidden)
    monkeypatch.setattr(Websites, '_enqueue', forbidden)
    for module in ('chat', 'agents', 'websites'):
        monkeypatch.setattr(f'studio.{module}.resolve_profile', forbidden)
    app = create_app(tmp_path / 'studio', config={}, worker_enabled=False)
    with TestClient(app) as client:
        token = client.get('/api/session').json()['token']
        client.headers['X-Studio-Token'] = token
        store = app.state.store
        first, second = [store.create_project(name)['id'] for name in ('Alpine', 'Beach')]
        yield SimpleNamespace(client=client, store=store, first=first, second=second,
                              token=token, app=app, tmp=tmp_path)


def text(work, project=None, content=b'Approved project text.', kind='text', metadata=None):
    return work.store.add_asset(project or work.first, kind, 'Synthetic result', content,
                               '.txt' if kind == 'text' else '.pdf', metadata or {})


def destination(work, asset, project=None):
    return f'/api/projects/{project or work.first}/assets/{asset["id"]}/text'


def insert_job(work, project=None, state='completed', asset=None, **request):
    identity = uid()
    with work.store.connect() as db:
        db.execute('INSERT INTO jobs(id,project,request,state,message,asset,created,updated) VALUES(?,?,?,?,?,?,?,?)',
                   (identity, project or work.first, json.dumps({'task':'write', **request}), state, 'Synthetic saved status', asset, 1, 2))
    return identity


def agent_run(work, project=None, jobs=None, asset=None, updated=1):
    project = project or work.first
    agent, identity = uid(), uid()
    definition = {'name':'Synthetic agent', 'purpose':'Review supplied text.', 'template':'custom', 'document_ids':[], 'profile_id':'auto', 'version':1}
    with work.store.connect() as db:
        db.execute('INSERT INTO agents VALUES(?,?,?,?)', (agent, project, json.dumps(definition), 1))
        snapshot = {'definition':definition, 'project':project, 'request':{'prompt':'Review this saved request.', 'project_brief':{'content':'Shared historical facts.', 'revision':2}}}
        db.execute('INSERT INTO agent_runs VALUES(?,?,?,?,?,?,?,?,?,?)',
                   (identity, agent, uid(), json.dumps(snapshot), 'completed', json.dumps(jobs or []), asset, 'Saved agent outcome', 1, updated))
    return identity, agent


def website_run(work, project=None, jobs=None, updated=1, request=None):
    identity = uid()
    result = {'title':'Saved website draft', 'pages':[]}
    with work.store.connect() as db:
        db.execute('INSERT INTO website_runs VALUES(?,?,?,?,?,?,?,?,?)',
                   (identity, project or work.first, 'completed', 'Review the saved draft.', json.dumps(request or {'artwork_count':0}), json.dumps(result), json.dumps(jobs or []), 1, updated))
    return identity


def test_text_and_extracted_document_targets_are_exact_and_read_only(work):
    original = 'Résumé and 日本語\n<script>literal source</script>'
    source = text(work, content=original.encode())
    document = text(work, kind='document', content=b'not opened as text', metadata={'extracted_text':source['id']})
    before = work.store.rows('SELECT * FROM assets')
    for asset in (source, document):
        response = work.client.get(destination(work, asset))
        assert response.status_code == 200, response.text
        assert response.json() == {'id':asset['id'], 'project_id':work.first, 'name':asset['name'],
                                   'kind':asset['kind'], 'text':original, 'text_asset_id':source['id']}
        assert response.headers['cache-control'] == 'no-store'
    assert work.store.rows('SELECT * FROM assets') == before
    assert not work.store.rows('SELECT * FROM jobs')
    assert work.app.state.worker.diagnostics()['state'] == 'stopped'


def test_text_cannot_cross_project_or_follow_foreign_extracted_metadata(work):
    secret = text(work, project=work.second, content=b'Private other project')
    assert work.client.get(destination(work, secret)).status_code == 400
    document = text(work, kind='document', metadata={'extracted_text':secret['id']})
    response = work.client.get(destination(work, document))
    assert response.status_code == 400 and 'Private other project' not in response.text
    assert work.client.get(destination(work, secret, work.second)).json()['text'] == 'Private other project'


@pytest.mark.parametrize('kind,metadata', [('image', {}), ('document', {}), ('document', {'extracted_text':'missing'})])
def test_nontext_and_missing_extractions_are_rejected(work, kind, metadata):
    asset = text(work, kind=kind, metadata=metadata)
    assert work.client.get(destination(work, asset)).status_code == 400


@pytest.mark.parametrize('content', [b'x'*800001, b'x'*200001, ('界'*200001).encode()])
def test_text_size_bounds_are_explicit_and_never_truncate(work, content):
    asset = text(work, content=content)
    response = work.client.get(destination(work, asset))
    assert response.status_code == 400 and 'too large' in response.text


@pytest.mark.parametrize('content', [b'\xffbroken', b'source\x00binary', b'source\x7fhidden'])
def test_binary_and_invalid_utf8_have_clean_errors(work, content):
    response = work.client.get(destination(work, text(work, content=content)))
    assert response.status_code == 400
    assert str(work.store.root) not in response.text


def test_changed_or_missing_saved_text_is_reported_cleanly(work):
    asset = text(work)
    path = work.store.file(asset)
    path.write_text('Changed outside Studio')
    response = work.client.get(destination(work, asset))
    assert response.status_code == 409 and 'changed on disk' in response.text
    path.unlink()
    response = work.client.get(destination(work, asset))
    assert response.status_code == 404 and str(path) not in response.text


@pytest.mark.parametrize('scenario', ['file_link', 'parent_link_inside', 'parent_link_outside', 'hardlink', 'foreign_metadata', 'private_metadata'])
def test_saved_text_rejects_symlinks_hardlinks_and_nonasset_paths(work, scenario):
    asset = text(work)
    path = work.store.file(asset)
    outside = work.tmp / 'private.txt'
    outside.write_text('SECRET FILE MUST NOT LEAK')
    if scenario == 'file_link':
        path.unlink();path.symlink_to(outside)
    elif scenario.startswith('parent_link'):
        destination_dir = work.store.root / 'other-files' if scenario.endswith('inside') else work.tmp / 'outside-assets'
        destination_dir.mkdir()
        (destination_dir / path.name).write_text('SECRET FILE MUST NOT LEAK')
        path.unlink();path.parent.rmdir();path.parent.symlink_to(destination_dir, target_is_directory=True)
    elif scenario == 'hardlink':
        path.unlink();os.link(outside, path)
    else:
        other = text(work, project=work.second, content=b'SECRET FILE MUST NOT LEAK')
        with work.store.connect() as db:
            db.execute('UPDATE assets SET path=? WHERE id=?',
                       (other['path'] if scenario == 'foreign_metadata' else 'session-token', asset['id']))
    response = work.client.get(destination(work, asset))
    assert response.status_code == 400, response.text
    assert 'SECRET FILE MUST NOT LEAK' not in response.text and str(work.tmp) not in response.text


@pytest.mark.skipif(os.name != 'posix', reason='Linux no-follow directory handles')
def test_text_read_rejects_parent_swap_after_path_check(work, monkeypatch):
    asset = text(work)
    path = work.store.file(asset)
    original = CodeFileAccess.read
    def swap(self, target):
        path.parent.rename(path.parent.with_name('previous-assets'))
        replacement = work.tmp / 'replacement';replacement.mkdir()
        (replacement / path.name).write_bytes(b'SECRET RACE CONTENT')
        path.parent.symlink_to(replacement, target_is_directory=True)
        return original(self, target)
    monkeypatch.setattr(CodeFileAccess, 'read', swap)
    response = work.client.get(destination(work, asset))
    assert response.status_code == 400
    assert 'SECRET RACE CONTENT' not in response.text


def test_check_draft_validates_without_creating_folders_files_assets_or_jobs(work):
    endpoint = f'/api/projects/{work.first}/code/check-draft'
    # SQLite may checkpoint/remove its temporary WAL files during a read.
    files = lambda: {path for path in work.store.root.rglob('*') if path.name not in ('studio.sqlite-wal', 'studio.sqlite-shm')}
    before = files()
    response = work.client.post(endpoint, json={'path':'src/reviewed.py', 'content':'print("review only")\n', 'version':None})
    assert response.status_code == 200 and response.json() == {'path':'src/reviewed.py', 'language':'python', 'version':None}
    assert files() == before
    assert not (work.store.root / 'projects' / work.first / 'code').exists()
    assert not work.store.rows('SELECT * FROM jobs') and not work.store.rows('SELECT * FROM assets')


@pytest.mark.parametrize('path', ['../private.py', '/tmp/private.py', r'C:\private.py', 'secrets.json', '.env', '.private/source.py', 'node_modules/main.js', 'src/../secret.py', 'CON.py', 'program.exe'])
def test_check_draft_rejects_paths_credentials_and_dependencies(work, path):
    response = work.client.post(f'/api/projects/{work.first}/code/check-draft', json={'path':path,'content':'reviewed'})
    assert response.status_code == 400
    assert not (work.store.root / 'projects' / work.first / 'code').exists()


def test_check_draft_collision_and_existing_version_never_overwrite(work):
    coding = work.app.state.coding
    saved = coding.write(work.first, 'main.py', 'KEEP THIS FILE\n')
    endpoint = f'/api/projects/{work.first}/code/check-draft'
    response = work.client.post(endpoint, json={'path':'main.py', 'content':'overwrite'})
    assert response.status_code == 409
    response = work.client.post(endpoint, json={'path':'new.py', 'content':'overwrite', 'version':saved['version']})
    assert response.status_code == 400
    assert coding.read(work.first, 'main.py')['content'] == 'KEEP THIS FILE\n'
    assert not (work.store.root / 'projects' / work.first / 'code' / 'new.py').exists()
    # Another project's existing name does not block this project's new draft.
    assert work.client.post(f'/api/projects/{work.second}/code/check-draft', json={'path':'main.py','content':'own draft'}).status_code == 200


@pytest.mark.parametrize('fields', [{'content':'\x00binary'}, {'content':'x'*524289}, {'content':'界'*200000}, {'path':'okay.py','execute':True}])
def test_check_draft_content_bounds_and_unknown_fields(work, fields):
    response = work.client.post(f'/api/projects/{work.first}/code/check-draft', json={'path':'okay.py','content':'valid',**fields})
    assert response.status_code in (400,422)
    assert not work.store.rows('SELECT * FROM jobs')


def test_check_draft_rejects_linked_code_root(work):
    root = work.store.root / 'projects' / work.first
    root.mkdir(parents=True)
    (root / 'code').symlink_to(work.tmp, target_is_directory=True)
    response = work.client.post(f'/api/projects/{work.first}/code/check-draft', json={'path':'new.py','content':'review'})
    assert response.status_code == 400 and not (work.tmp / 'new.py').exists()


def test_exact_old_run_destinations_preserve_snapshots_and_project_boundaries(work, monkeypatch):
    draft = text(work, content=b'Saved draft')
    final = text(work, content=b'Saved reviewed reply')
    first = insert_job(work, asset=draft['id'], purpose='agent-draft')
    second = insert_job(work, asset=final['id'], purpose='agent-review')
    old, agent = agent_run(work, jobs=[first,second], asset=final['id'])
    for index in range(25):
        agent_run(work, updated=index+2)
    old_site = website_run(work, jobs=[first], request={'kind':'page-copy'}, updated=1)
    for index in range(25):
        website_run(work, updated=index+2)
    # Unrelated corrupt history must not be read to open the requested outcome.
    with work.store.connect() as db:
        db.execute('UPDATE website_runs SET jobs=? WHERE id!=?', ('["missing-other-run-job"]', old_site))
    monkeypatch.setattr(Agents, 'get_run', lambda *args:pytest.fail('Hydrate only the scoped exact run.'))
    monkeypatch.setattr(Websites, 'runs', lambda *args:pytest.fail('Do not hydrate every historical website run.'))
    result = work.client.get(f'/api/projects/{work.first}/agent-runs/{old}')
    assert result.status_code == 200, result.text
    data = result.json()
    assert data['id'] == old and data['agent'] == agent and data['draft_text'] == 'Saved draft'
    assert data['text'] == 'Saved reviewed reply' and data['project_brief']['revision'] == 2
    result = work.client.get(f'/api/projects/{work.first}/website-runs/{old_site}')
    assert result.status_code == 200, result.text
    assert result.json()['progress'] == {'completed':1,'total':1}
    assert result.json()['job_details'][0]['id'] == first
    for route,identity in [('agent-runs',old),('website-runs',old_site),('jobs',first)]:
        assert work.client.get(f'/api/projects/{work.second}/{route}/{identity}').status_code == 404
        assert work.client.get(f'/api/projects/{work.first}/{route}/{identity}').status_code == 200


@pytest.mark.parametrize('kind', ['agent', 'website'])
def test_run_destination_rejects_foreign_child_jobs(work, kind):
    foreign = insert_job(work, project=work.second)
    identity = agent_run(work, jobs=[foreign])[0] if kind=='agent' else website_run(work, jobs=[foreign])
    response = work.client.get(f'/api/projects/{work.first}/{kind}-runs/{identity}')
    assert response.status_code == 409


def test_agent_result_rejects_foreign_asset_reference(work):
    foreign = text(work, project=work.second, content=b'SECRET OTHER PROJECT')
    identity,_ = agent_run(work, asset=foreign['id'])
    response = work.client.get(f'/api/projects/{work.first}/agent-runs/{identity}')
    assert response.status_code == 400 and 'SECRET OTHER PROJECT' not in response.text


def test_all_new_routers_are_authenticated_and_metadata_only(work):
    client, project = work.client, work.first
    source = text(work, content=b'Approved searchable phrase')
    saved_job = insert_job(work, asset=source['id'])
    before_jobs = work.store.rows('SELECT * FROM jobs')
    search = client.get(f'/api/projects/{project}/search', params={'q':'searchable'})
    assert search.status_code == 200 and search.json()['results']
    assert search.json()['project_id'] == project
    inbox = client.get('/api/inbox').json()
    assert len(inbox['events']) == 1
    recipe = {'name':'Synthetic recipe', 'target':'coding', 'template':'Explain {{topic}}.'}
    endpoints = [('/api/recipes',recipe),('/api/inbox/read',{'event_ids':[inbox['events'][0]['id']]}),
                 (f'/api/projects/{project}/code/check-draft',{'path':'draft.py','content':'review only'})]
    for endpoint,body in endpoints:
        assert client.post(endpoint,json=body,headers={'X-Studio-Token':''}).status_code == 403
        assert client.post(endpoint,json=body,headers={'Origin':'https://external.invalid'}).status_code == 403
        assert client.post(endpoint,json=body,headers={'Sec-Fetch-Site':'cross-site'}).status_code == 403
    client.cookies.clear()
    for endpoint in ('/api/inbox','/api/recipes',f'/api/projects/{project}/search?q=phrase',destination(work,source)):
        assert client.get(endpoint).status_code == 401
    for endpoint,body in endpoints:
        assert client.post(endpoint,json=body).status_code == 401
    client.get('/api/session').raise_for_status()
    created = client.post('/api/recipes',json=recipe)
    assert created.status_code == 201
    identity=created.json()['id']
    rendered=client.post(f'/api/recipes/{identity}/render',json={'expected_revision':1,'values':{'topic':'safe code'}})
    assert rendered.status_code == 200 and rendered.json()['prompt'] == 'Explain safe code.'
    assert client.get('/api/recipes').json()[0]['id'] == identity
    assert client.post('/api/inbox/read',json=endpoints[1][1]).status_code == 200
    assert client.get('/api/inbox').json()['unread'] == 0
    assert client.get(f'/api/projects/{project}/jobs/{saved_job}').json()['id'] == saved_job
    assert work.store.rows('SELECT * FROM jobs') == before_jobs
    assert not work.store.rows('SELECT * FROM job_events')
