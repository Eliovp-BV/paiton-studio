"""Managed source files are inert, bounded, private and revision checked."""
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import threading
import zipfile

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
import pytest

from studio import coding
from studio.coding import CodingWorkspace, code_path
from studio.export import export_project
from studio.store import Store


class NoChats:
    def __getattr__(self, name):
        raise AssertionError('Code file actions must not call a model or create a chat.')


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    monkeypatch.setattr(subprocess, 'run', lambda *args, **kwargs: pytest.fail('Source code must never launch a process.'))
    store = Store(tmp_path / 'data')
    manager = CodingWorkspace(store, NoChats())
    project = store.create_project()['id']
    return manager, project


def client(workspace):
    manager, project = workspace
    app = FastAPI()
    app.include_router(manager.router())
    @app.exception_handler(ValueError)
    async def invalid(request, error):
        return JSONResponse({'error': str(error)}, 400)
    return TestClient(app), f'/api/projects/{project}/code'


def test_snapshot_reports_external_editor_path_without_creating_any_code_folder(workspace):
    manager, project = workspace
    snapshot = manager.snapshot(project)
    assert snapshot['root'] == str(manager.store.root / 'projects' / project / 'code')
    assert not snapshot['exists'] and snapshot['files'] == []
    assert not (manager.store.root / 'projects').exists()
    assert not snapshot['execution_enabled'] and snapshot['starters'] == ['empty', 'python', 'static-web']
    browser, base = client(workspace)
    assert browser.get(base + '/file', params={'path': 'main.py'}).status_code == 404
    assert not (manager.store.root / 'projects').exists()


def test_create_read_update_with_exact_hash_and_external_editor_changes(workspace):
    manager, project = workspace
    first = manager.write(project, 'src/main.py', 'print("hello")\n')
    assert first['language'] == 'python'
    assert first['version'] == hashlib.sha256(first['content'].encode()).hexdigest()
    assert first['size'] == len(first['content'].encode()) and first['updated_at'] > 0
    target = Path(manager.snapshot(project)['root']) / 'src/main.py'
    assert target.read_text() == first['content']
    target.write_text('print("edited in VS Code")\n')
    with pytest.raises(HTTPException) as failure:
        manager.write(project, 'src/main.py', 'stale browser draft\n', first['version'])
    assert failure.value.status_code == 409
    assert target.read_text() == 'print("edited in VS Code")\n'
    external = manager.read(project, 'src/main.py')
    second = manager.write(project, 'src/main.py', 'print("reviewed merge")\n', external['version'])
    assert second['version'] != first['version'] and target.read_text() == second['content']


@pytest.mark.parametrize('scenario', ['existing_create', 'wrong_hash', 'externally_deleted'])
def test_conflicts_never_overwrite_or_resurrect_without_review(workspace, scenario):
    manager, project = workspace
    first = manager.write(project, 'main.py', 'first\n')
    target = Path(manager.snapshot(project)['root']) / 'main.py'
    version = None if scenario == 'existing_create' else 'a' * 64
    if scenario == 'externally_deleted':
        version = first['version']
        target.unlink()
    with pytest.raises(HTTPException) as failure:
        manager.write(project, 'main.py', 'replacement\n', version)
    assert failure.value.status_code == 409
    assert not target.exists() if scenario == 'externally_deleted' else target.read_text() == 'first\n'


def test_http_contract_and_project_isolation(workspace):
    manager, project = workspace
    browser, base = client(workspace)
    result = browser.put(base + '/file', json={'path': 'main.js', 'content': 'const value = 1;\n', 'version': None})
    assert result.status_code == 200
    assert browser.get(base + '/file', params={'path': 'main.js'}).json() == result.json()
    assert browser.put(base + '/file', json={'path': 'main.js', 'content': 'changed', 'version': None}).status_code == 409
    other = manager.store.create_project()['id']
    assert manager.snapshot(other)['files'] == []
    assert browser.get(f'/api/projects/{other}/code/file', params={'path': 'main.js'}).status_code == 404


@pytest.mark.parametrize('path', [
    '../secret.py', '/tmp/file.py', 'a/../../secret.py', 'a\\b.py', 'C:/file.py',
    'a//file.py', './file.py', '.env', '.env.local', '.git/config', '.ssh/id_rsa',
    'node_modules/a/index.js', '.venv/main.py', 'credentials.json', 'secrets.local.yaml',
    'main.py:secret', 'CON.py', 'aux.txt', 'name./file.py', 'file.py ', 'bad\x00.py',
    'picture.png', 'archive.zip', 'a/' * 13 + 'main.py',
])
def test_private_and_nonportable_paths_are_rejected_without_mutation(workspace, path):
    manager, project = workspace
    with pytest.raises(ValueError):
        manager.write(project, path, 'content')
    assert not (manager.store.root / 'projects').exists()


@pytest.mark.parametrize('where', ['code', 'project', 'projects', 'parent', 'file'])
def test_symlinks_cannot_escape_at_any_managed_component(workspace, tmp_path, where):
    manager, project = workspace
    outside = tmp_path / 'outside'
    outside.mkdir()
    (outside / 'main.py').write_text('private outside source')
    root = manager.store.root / 'projects' / project / 'code'
    if where == 'code':
        root.parent.mkdir(parents=True)
        root.symlink_to(outside, target_is_directory=True)
        relative = 'main.py'
    elif where == 'project':
        root.parent.parent.mkdir()
        root.parent.symlink_to(outside, target_is_directory=True)
        relative = 'main.py'
    elif where == 'projects':
        root.parent.parent.symlink_to(outside, target_is_directory=True)
        relative = 'main.py'
    else:
        root.mkdir(parents=True)
        relative = 'src/main.py' if where == 'parent' else 'main.py'
        (root / ('src' if where == 'parent' else 'main.py')).symlink_to(outside if where == 'parent' else outside / 'main.py', target_is_directory=where == 'parent')
    with pytest.raises(ValueError, match='Linked'):
        manager.read(project, relative)
    with pytest.raises(ValueError, match='Linked'):
        manager.write(project, relative, 'overwrite')
    assert (outside / 'main.py').read_text() == 'private outside source'


def test_replaced_store_root_is_checked_before_database_access(workspace, tmp_path):
    manager, project = workspace
    original = manager.store.root
    original.rename(tmp_path / 'old-data')
    outside = tmp_path / 'outside'
    outside.mkdir()
    original.symlink_to(outside, target_is_directory=True)
    with pytest.raises(ValueError, match='Linked'):
        manager.snapshot(project)
    assert list(outside.iterdir()) == []


def test_list_and_zip_export_only_supported_regular_utf8_sources(workspace, tmp_path):
    manager, project = workspace
    manager.write(project, 'src/main.py', 'print("hello")\n')
    manager.write(project, '.gitignore', '.venv/\n')
    root = Path(manager.snapshot(project)['root'])
    (root / '.env').write_text('SECRET=do-not-export')
    (root / 'credentials.json').write_text('{"password":"private"}')
    (root / 'binary.py').write_bytes(b'\xff\x00\x01')
    (root / 'large.py').write_bytes(b'x' * (coding.MAX_FILE_BYTES + 1))
    for directory in ('.git', 'node_modules', '.venv'):
        (root / directory).mkdir()
        (root / directory / 'hidden.py').write_text('private or dependency source')
    outside = tmp_path / 'outside.py'
    outside.write_text('private outside source')
    (root / 'linked.py').symlink_to(outside)
    os.link(outside, root / 'hardlinked.py')
    snapshot = manager.snapshot(project)
    assert {item['path'] for item in snapshot['files']} == {'.gitignore', 'src/main.py'}
    assert snapshot['skipped'] >= 8
    with pytest.raises(ValueError, match='larger than 512 KB'):
        manager.export(project)
    (root / 'large.py').unlink()
    exported = manager.export(project)
    with zipfile.ZipFile(io.BytesIO(exported.body)) as archive:
        assert set(archive.namelist()) == {'.gitignore', 'src/main.py'}
        assert archive.read('src/main.py') == b'print("hello")\n'
    with pytest.raises(ValueError, match='hard-linked'):
        manager.read(project, 'hardlinked.py')


@pytest.mark.parametrize('content', ['\x00binary', '\x1bescape', '\ud800'])
def test_binary_or_invalid_unicode_cannot_be_written(workspace, content):
    manager, project = workspace
    with pytest.raises(ValueError):
        manager.write(project, 'main.py', content)


def test_limits_count_utf8_bytes_and_protect_existing_project(workspace, monkeypatch):
    manager, project = workspace
    with pytest.raises(ValueError, match='512 KB'):
        manager.write(project, 'large.py', '🌲' * (coding.MAX_FILE_BYTES // 4 + 1))
    monkeypatch.setattr(coding, 'MAX_FILES', 2)
    monkeypatch.setattr(coding, 'MAX_TOTAL_BYTES', 12)
    manager.write(project, 'one.py', '12345')
    second = manager.write(project, 'two.py', '12345')
    with pytest.raises(ValueError, match='256 files'):
        manager.write(project, 'three.py', '1')
    with pytest.raises(ValueError, match='8 MB'):
        manager.write(project, 'two.py', '12345678', second['version'])
    assert manager.read(project, 'two.py')['content'] == '12345'
    root = Path(manager.snapshot(project)['root'])
    (root / 'three.py').write_text('1')
    assert manager.snapshot(project)['over_limit']
    with pytest.raises(ValueError, match='limits'):
        manager.export(project)


@pytest.mark.parametrize('template,files', [
    ('empty', set()), ('python', {'main.py', '.gitignore'}),
    ('static-web', {'index.html', 'styles.css', 'main.js'})])
def test_starters_are_explicit_inert_files_and_never_overwrite(workspace, template, files):
    manager, project = workspace
    before = manager.snapshot(project)
    assert not before['exists']
    result = manager.starter(project, template)
    assert result['exists'] and {item['path'] for item in result['files']} == files
    if files:
        with pytest.raises(HTTPException) as failure:
            manager.starter(project, 'empty')
        assert failure.value.status_code == 409
    else:
        (Path(result['root']) / '.env').write_text('private existing setting')
        with pytest.raises(HTTPException):
            manager.starter(project, 'python')


def test_simultaneous_browser_updates_have_one_winner(workspace):
    manager, project = workspace
    initial = manager.write(project, 'main.py', 'start')
    results = []
    barrier = threading.Barrier(2)
    def save(text):
        barrier.wait()
        try:
            results.append(manager.write(project, 'main.py', text, initial['version']))
        except HTTPException as error:
            results.append(error.status_code)
    threads = [threading.Thread(target=save, args=(text,)) for text in ('first', 'second')]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert sum(isinstance(result, dict) for result in results) == 1 and 409 in results


def test_updates_preserve_executable_permission_without_executing(workspace):
    manager, project = workspace
    first = manager.write(project, 'hello.sh', '#!/bin/sh\necho hello\n')
    path = Path(manager.snapshot(project)['root']) / 'hello.sh'
    path.chmod(0o755)
    manager.write(project, 'hello.sh', '#!/bin/sh\necho reviewed\n', first['version'])
    assert stat.S_IMODE(path.stat().st_mode) == 0o755


def test_save_rechecks_external_changes_after_preparing_workspace(workspace, monkeypatch):
    manager, project = workspace
    first = manager.write(project, 'main.py', 'original')
    original_snapshot = manager.snapshot
    path = Path(original_snapshot(project)['root']) / 'main.py'
    def changed_snapshot(identity):
        result = original_snapshot(identity)
        path.write_text('saved by VS Code during preparation')
        return result
    monkeypatch.setattr(manager, 'snapshot', changed_snapshot)
    with pytest.raises(HTTPException) as failure:
        manager.write(project, 'main.py', 'stale browser change', first['version'])
    assert failure.value.status_code == 409
    assert path.read_text() == 'saved by VS Code during preparation'
    assert not list(path.parent.glob('.studio-code-*'))


def test_new_file_publication_cannot_replace_concurrent_external_creation(workspace, monkeypatch):
    manager, project = workspace
    root = Path(manager.starter(project, 'empty')['root'])
    original_publish = manager.access.publish
    def competing_create(path, directory, temporary, create):
        path.write_text('created externally')
        return original_publish(path, directory, temporary, create)
    monkeypatch.setattr(manager.access, 'publish', competing_create)
    with pytest.raises(HTTPException) as failure:
        manager.write(project, 'main.py', 'browser new file')
    assert failure.value.status_code == 409
    assert (root / 'main.py').read_text() == 'created externally'
    assert not list(root.glob('.studio-code-*'))


def test_export_refuses_a_file_changed_after_its_snapshot(workspace, monkeypatch):
    manager, project = workspace
    manager.write(project, 'main.py', 'original')
    path = Path(manager.snapshot(project)['root']) / 'main.py'
    original_read = manager.read
    def changed_read(project, relative):
        path.write_text('changed during export')
        return original_read(project, relative)
    monkeypatch.setattr(manager, 'read', changed_read)
    with pytest.raises(HTTPException) as failure:
        manager.export(project)
    assert failure.value.status_code == 409


def test_direct_special_file_read_does_not_block(workspace):
    if not hasattr(os, 'mkfifo'):
        pytest.skip('POSIX-only special file fixture')
    manager, project = workspace
    root = Path(manager.starter(project, 'empty')['root'])
    os.mkfifo(root / 'pipe.py')
    with pytest.raises(ValueError, match='regular'):
        manager.read(project, 'pipe.py')


def test_project_export_includes_code_with_portable_manifest_and_no_private_files(workspace):
    manager, project = workspace
    manager.write(project, 'src/main.py', 'print("portable source")\n')
    manager.write(project, '.gitignore', '.venv/\n')
    root = Path(manager.snapshot(project)['root'])
    (root / '.env').write_text('PRIVATE_CREDENTIAL=do-not-export')
    (root / 'credentials.json').write_text('{"password":"do-not-export"}')
    (root / 'node_modules').mkdir()
    (root / 'node_modules' / 'dependency.js').write_text('not project source')
    destination = export_project(manager.store, project)
    with zipfile.ZipFile(destination) as archive:
        assert {name for name in archive.namelist() if name.startswith('code/')} == {'code/src/main.py', 'code/.gitignore'}
        assert archive.read('code/src/main.py') == b'print("portable source")\n'
        manifest_bytes = archive.read('project.json')
        manifest = json.loads(manifest_bytes)
        assert {item['path'] for item in manifest['coding']['files']} == {'code/src/main.py', 'code/.gitignore'}
        assert all(item['version'] and item['updated_at'] for item in manifest['coding']['files'])
        assert str(manager.store.root).encode() not in manifest_bytes
        assert b'PRIVATE_CREDENTIAL' not in destination.read_bytes()


@pytest.mark.parametrize('limit', ['file_size', 'file_count', 'total_size', 'scan'])
def test_both_exports_refuse_oversized_source_without_partial_archive(workspace, monkeypatch, limit):
    manager, project = workspace
    root = Path(manager.starter(project, 'empty')['root'])
    (root / 'one.py').write_text('1234567')
    (root / 'two.py').write_text('1234567')
    constant, value = {'file_size': ('MAX_FILE_BYTES', 6), 'file_count': ('MAX_FILES', 1),
                       'total_size': ('MAX_TOTAL_BYTES', 10), 'scan': ('MAX_SCAN_ENTRIES', 1)}[limit]
    monkeypatch.setattr(coding, constant, value)
    with pytest.raises(ValueError, match='export|Export'):
        manager.export(project)
    with pytest.raises(ValueError, match='export|Export'):
        export_project(manager.store, project)
    assert not (manager.store.root / 'exports').exists()


def test_project_export_does_not_create_code_folder(workspace):
    manager, project = workspace
    destination = export_project(manager.store, project)
    with zipfile.ZipFile(destination) as archive:
        assert json.loads(archive.read('project.json'))['coding'] == {'files': []}
    assert not (manager.store.root / 'projects').exists()


def test_supporting_context_captures_exact_reviewed_saved_files(workspace):
    manager, project = workspace
    first = manager.write(project, 'src/helper.py', 'VALUE = "🌲"\n')
    selected = manager.context(project, [{'path': first['path'], 'version': first['version']}])
    assert selected == [{**first, 'characters': len(first['content']), 'source': 'project-code'}]
    assert manager.context(project, []) == []


@pytest.mark.parametrize('change', ['changed', 'deleted', 'other_project'])
def test_supporting_context_rejects_stale_or_cross_project_file(workspace, change):
    manager, project = workspace
    item = manager.write(project, 'helper.py', 'original')
    selected = [{'path': item['path'], 'version': item['version']}]
    target = Path(manager.snapshot(project)['root']) / item['path']
    if change == 'changed':
        target.write_text('new external revision')
    elif change == 'deleted':
        target.unlink()
    else:
        project = manager.store.create_project()['id']
    with pytest.raises(HTTPException) as failure:
        manager.context(project, selected)
    assert failure.value.status_code == 409
    assert 'helper.py' in failure.value.detail


def test_supporting_context_has_explicit_file_and_total_character_bounds(workspace):
    manager, project = workspace
    first = manager.write(project, 'one.py', '🌲' * 7000)
    second = manager.write(project, 'two.py', 'b' * 5000)
    refs = [{'path': item['path'], 'version': item['version']} for item in (first, second)]
    assert sum(item['characters'] for item in manager.context(project, refs)) == 12000
    with pytest.raises(ValueError, match='more than once'):
        manager.context(project, refs[:1] * 2)
    with pytest.raises(ValueError, match='at most 4'):
        manager.context(project, refs[:1] * 5)
    second = manager.write(project, 'two.py', 'b' * 5001, second['version'])
    refs[1]['version'] = second['version']
    with pytest.raises(ValueError, match='12,001.*12,000'):
        manager.context(project, refs)


@pytest.mark.parametrize('path', ['.env', 'credentials.json', 'node_modules/private.js', '../outside.py'])
def test_supporting_context_never_reads_private_paths(workspace, path):
    manager, project = workspace
    with pytest.raises(ValueError):
        manager.context(project, [{'path': path, 'version': 'a' * 64}])


def test_content_search_is_literal_case_aware_and_reports_exact_browser_offsets(workspace):
    manager, project = workspace
    saved = manager.write(project, 'src/main.py', '😀 prefix\n    Needle.* first NEEDLE.*\nlast\n')
    result = manager.search(project, 'needle.*')
    assert len(result['matches']) == 2 and result['searched_files'] == 1
    first = result['matches'][0]
    assert first['path'] == saved['path'] and first['version'] == saved['version']
    assert first['line'] == 2 and first['column'] == 5
    encoded = saved['content'].encode('utf-16-le')
    assert encoded[first['start'] * 2:first['end'] * 2].decode('utf-16-le') == 'Needle.*'
    assert manager.search(project, 'needle.*', True)['matches'] == []
    assert len(manager.search(project, 'NEEDLE.*', True)['matches']) == 1
    browser, base = client(workspace)
    assert browser.get(base + '/search', params={'query': 'NEEDLE.*', 'case_sensitive': True}).json()['matches'][0]['column'] == 20
    other = manager.store.create_project()['id']
    assert manager.search(other, 'Needle')['matches'] == []


def test_search_never_reads_excluded_paths_and_limits_results(workspace, monkeypatch, tmp_path):
    manager, project = workspace
    manager.write(project, 'main.py', 'needle\n' * 202)
    root = Path(manager.snapshot(project)['root'])
    for path in ['.env', 'secrets.json', '.private/hidden.py', 'node_modules/package/main.js', 'blob.bin']:
        destination = root / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text('needle PRIVATE')
    outside = tmp_path / 'outside.py'
    outside.write_text('needle PRIVATE')
    (root / 'linked.py').symlink_to(outside)
    observed = []
    original = manager._read
    def read(target, relative, language):
        observed.append(relative)
        return original(target, relative, language)
    monkeypatch.setattr(manager, '_read', read)
    result = manager.search(project, 'needle')
    assert len(result['matches']) == 200 and result['limit_reached']
    assert set(observed) == {'main.py'}
    assert result['skipped'] >= 5
    assert 'PRIVATE' not in json.dumps(result)


@pytest.mark.parametrize('change', ['edited', 'removed', 'linked'])
def test_search_refuses_results_from_changed_snapshot(workspace, monkeypatch, tmp_path, change):
    manager, project = workspace
    saved = manager.write(project, 'main.py', 'needle\n')
    target = Path(manager.snapshot(project)['root']) / saved['path']
    original = manager.snapshot
    def changed(identity):
        value = original(identity)
        if change == 'edited':
            target.write_text('new needle\n')
        else:
            target.unlink()
            if change == 'linked':
                outside = tmp_path / 'outside.py'
                outside.write_text('PRIVATE needle')
                target.symlink_to(outside)
        return value
    monkeypatch.setattr(manager, 'snapshot', changed)
    with pytest.raises(HTTPException) as failure:
        manager.search(project, 'needle')
    assert failure.value.status_code == 409


@pytest.mark.parametrize('query', ['', 'x' * 201, 'a\nb', '\x00'])
def test_content_search_rejects_unbounded_or_multiline_queries(workspace, query):
    manager, project = workspace
    with pytest.raises(ValueError):
        manager.search(project, query)


def test_coding_preferences_persist_with_revision_conflicts_without_model_readiness(workspace, monkeypatch):
    manager, project = workspace
    from studio.registry import compatible_profiles
    chosen = compatible_profiles('code')[0]['id']
    monkeypatch.setattr('studio.preferences.resolve_profile', lambda *args: pytest.fail('Saving preferences must not check or load a model.'))
    before = manager.preferences(project)
    assert before == {'profile_id': 'auto', 'instructions': '', 'version': None}
    assert not manager.store.rows('SELECT * FROM preferences')
    first = manager.save_preferences(project, {'profile_id': chosen, 'instructions': 'Use type hints.', 'version': None})
    assert first['profile_id'] == chosen and first['instructions'] == 'Use type hints.' and len(first['version']) == 64
    reopened = CodingWorkspace(Store(manager.store.root))
    assert reopened.preferences(project) == first
    second = reopened.save_preferences(project, {**first, 'instructions': 'Keep changes focused.'})
    assert first['version'] != second['version']
    with pytest.raises(HTTPException) as failure:
        manager.save_preferences(project, {**first, 'instructions': 'Stale preferences'})
    assert failure.value.status_code == 409
    assert manager.preferences(project) == second
    other = manager.store.create_project()['id']
    assert manager.preferences(other) == before
    assert not (manager.store.root / 'projects').exists()


def test_coding_preferences_validate_profiles_and_http_contract(workspace):
    manager, project = workspace
    browser, base = client(workspace)
    assert browser.get(base + '/preferences').json()['version'] is None
    invalid = browser.put(base + '/preferences', json={'profile_id': 'image-standard', 'instructions': '', 'version': None})
    assert invalid.status_code == 400 and 'coding' in invalid.json()['error']
    assert browser.put(base + '/preferences', json={'instructions': 'x' * 2001}).status_code == 422
    result = browser.put(base + '/preferences', json={'instructions': 'Prefer readable names.'})
    assert result.status_code == 200
    assert browser.get(base + '/preferences').json() == result.json()
    assert browser.put(base + '/preferences', json={'instructions': 'Stale', 'version': None}).status_code == 409
