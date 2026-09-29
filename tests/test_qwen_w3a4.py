"""CPU fixtures only: public contract metadata, tiny synthetic files and fake Docker."""
from contextlib import redirect_stdout
import hashlib
import io
import json
import os
from pathlib import Path
from subprocess import CompletedProcess, TimeoutExpired
from types import SimpleNamespace
import sys
import threading

import pytest

from studio import qwen_mxfp4 as release
from studio.setup import SetupManager, SetupFailure, SetupCancelled
from studio.runtime import RuntimeFailure
from studio.store import Store


def inspected(reference=release.IMAGE):
    return json.dumps([{'Id': reference.split('@')[1], 'RepoDigests': [reference]}])


def model(repository, revision, content):
    return {'repository': repository, 'revision': revision,
            'files': {'model.safetensors': {'bytes': len(content), 'sha256': hashlib.sha256(content).hexdigest()}},
            'license': 'Apache-2.0', 'license_url': 'https://huggingface.co/example/model/blob/' + revision + '/LICENSE'}


@pytest.fixture
def tiny_contracts(monkeypatch):
    contents = {'legacy': b'old target', 'new': b'new target', 'draft': b'shared draft', 'w3': b'optional weights'}
    legacy = {'target': model('example/legacy', 'legacy', contents['legacy']),
              'draft': model('example/draft', 'draft', contents['draft'])}
    current = {'target': model('example/new', 'new', contents['new']), 'draft': legacy['draft']}
    optional = {'w3a4': model('example/w3', 'w3', contents['w3'])}
    monkeypatch.setattr(release, 'MODELS', legacy)
    monkeypatch.setattr(release, 'NEW_MODELS', current)
    monkeypatch.setattr(release, 'OPTIONAL_COMPONENTS', optional)
    monkeypatch.setattr(release, 'W3_DOWNLOAD_BYTES', len(contents['w3']))
    monkeypatch.setattr(release, '_VERIFIED', {})
    return contents


class Response(io.BytesIO):
    def __init__(self, content, offset=0):
        super().__init__(content[offset:])
        self.status = 206 if offset else 200
        self.headers = {'Content-Length': str(len(content) - offset)}
        if offset:
            self.headers['Content-Range'] = f'bytes {offset}-{len(content)-1}/{len(content)}'

    def getcode(self):
        return self.status


@pytest.fixture
def manager(tmp_path, tiny_contracts):
    store = Store(tmp_path / 'data')
    commands = []

    def command(args, **kwargs):
        commands.append(args)
        assert args[:2] == ['image', 'inspect'], 'Unexpected Docker operation'
        return CompletedProcess(args, 0, inspected(args[-1]), '')

    runtime = SimpleNamespace(config={}, command=command, owner='test-owner', preflight=lambda _: release.IMAGE)
    result = SetupManager(store, runtime, config_path=tmp_path / 'config.local.json')
    result.commands = commands
    result.run = lambda args, job: command(args[1:])
    result.requests = []

    def opened(url, headers=None):
        revision = url.split('/resolve/')[1].split('/')[0]
        offset = int(headers.get('Range', 'bytes=0-').split('=')[1].split('-')[0]) if headers else 0
        result.requests.append((revision, offset))
        return Response(tiny_contracts[revision], offset)

    result._open = opened
    result._system = lambda: {'ready': True, 'can_download': True, 'docker': True, 'driver': True,
        'supported_gpu': True, 'disk_free_bytes': 100_000_000_000, 'docker_disk_free_bytes': 100_000_000_000,
        'checks': [], 'message': 'Ready', 'gpu': {'supported': True, 'driver_available': True,
        'gpu_count': 1, 'name': 'AMD Radeon AI PRO R9700', 'architecture': 'gfx1201', 'total': 32 * 1024**3}}
    result._readiness = lambda _: (True, 'Ready')
    return result


def job(manager, identity='base', component=None):
    with manager.store.connect() as db:
        db.execute('INSERT INTO setup_jobs(id,package,state,message,created,updated,component) VALUES(?,?,?,?,?,?,?)',
                   (identity, 'qwen38-mxfp4', 'queued', 'Synthetic setup', 1, 1, component))
    return manager.job(identity)


def installed(manager):
    current = job(manager)
    release.install(manager, current)
    manager.update(current, 'completed', 'Ready')
    return current


def test_manifests_pin_new_target_shared_draft_and_optional_weights():
    assert release.LEGACY_MANIFEST_SHA256 == 'a509a4e44383752a1115c795ba8ad6295780bd9392571a2cdeec3340e7378baa'
    assert release.MODELS['target']['repository'] == 'amd/Qwen3.8-27B-Quark-AWQ-MXFP4'
    assert release.NEW_MODELS['target']['repository'] == 'unsloth/Qwen3.8-27B-NVFP4'
    assert release.NEW_MODELS['target']['revision'] == 'f0b7c9e722f5565102fff8481c99e4d86ae099c7'
    assert release.NEW_MODELS['draft'] == release.MODELS['draft']
    spec = release.OPTIONAL_COMPONENTS['w3a4']
    assert spec['revision'] == '278486debe64e21e5e9d45ac8d02798d72fbdf83'
    assert len(spec['files']) == 72
    assert release.W3_DOWNLOAD_BYTES == 9_550_285_694
    assert release.DOWNLOAD_BYTES == 25_563_397_892
    for spec in [*release.NEW_MODELS.values(), *release.OPTIONAL_COMPONENTS.values()]:
        for name, record in spec['files'].items():
            assert Path(name).name == name and name not in ('.', '..')
            assert record['bytes'] > 0 and len(record['sha256']) == 64


@pytest.mark.parametrize('reference', release.APPROVED_IMAGES)
def test_immutable_image_families_accept_index_and_exact_repo_digest(reference):
    assert release.verify_image(inspected(reference), reference) == reference
    config_id = 'sha256:' + 'f' * 64
    classic = json.dumps([{'Id': config_id, 'RepoDigests': [reference]}])
    assert release.verify_image(classic, config_id) == reference
    assert release.image_family(config_id, classic) == ('rocm10' if reference in release.ROCM10_IMAGES else 'legacy')


@pytest.mark.parametrize('metadata', [
    [{'Id': 'sha256:' + 'f' * 64, 'RepoTags': [release.IMAGE]}],
    [{'Id': 'sha256:' + 'f' * 64, 'RepoDigests': release.IMAGE}],
    [{'Id': 'sha256:' + 'f' * 64, 'RepoDigests': [release.IMAGE, release.LEGACY_200K_IMAGE]}],
    [], {'Id': 'sha256:' + 'f' * 64},
])
def test_tag_only_ambiguous_or_invalid_inspection_fails(metadata):
    with pytest.raises(ValueError, match='pinned'):
        release.verify_image(json.dumps(metadata), 'sha256:' + 'f' * 64)


def test_sources_choose_target_by_image_and_weights_only_add_optional_mount(tmp_path):
    config = {}
    for key in ('qwen38_mxfp4_target_dir', 'qwen38_nvfp4_target_dir', 'qwen38_mxfp4_draft_dir', 'qwen38_w3rot_dir'):
        path = tmp_path / key
        path.mkdir()
        config[key] = str(path)
    old = release.source_contract(config, release.LEGACY_200K_IMAGE)
    new = release.source_contract(config, release.IMAGE)
    previous = release.source_contract(config, release.PREVIOUS_65K_IMAGE)
    w3 = release.source_contract(config, release.IMAGE, 'w3a4')
    assert old['components']['target']['directory'] == config['qwen38_mxfp4_target_dir']
    assert new['components']['target']['directory'] == config['qwen38_nvfp4_target_dir']
    assert previous == new
    assert release.source_contract(config, release.PREVIOUS_65K_IMAGE, 'w3a4') == w3
    assert w3['components']['target'] == new['components']['target']
    assert w3['paths']['w3a4'] == '/models/w3rot'
    assert w3['environment']['PAITON_W3_A4_DIR'] == w3['environment']['PAITON_W3ROT_DIR'] == '/models/w3rot'
    assert w3['environment']['PYTORCH_ALLOC_CONF'] == 'max_split_size_mb:64'
    assert all(new['environment'][name] == '0' and w3['environment'][name] == '1'
               for name in ('PAITON_W3_DECODE', 'PAITON_W3_PREFILL', 'PAITON_W3_A4'))
    assert len(new['mounts']) == 2 and len(w3['mounts']) == 3
    with pytest.raises(ValueError, match='legacy runtimes'):
        release.source_contract(config, release.LEGACY_200K_IMAGE, 'w3a4')


def test_shared_draft_install_does_not_break_legacy_target_in_volume(tmp_path):
    draft = tmp_path / 'draft'; draft.mkdir()
    config = {'qwen38_mxfp4_draft_dir': str(draft), 'qwen38_mxfp4_cache_volume': 'existing-cache'}
    selected = release.source_contract(config, release.LEGACY_200K_IMAGE)
    assert selected['components']['target']['volume'] == 'existing-cache'
    assert selected['components']['draft']['directory'] == str(draft)
    assert selected['paths']['target'].endswith('/' + release.MODELS['target']['revision'])
    config['qwen38_mxfp4_target_dir'] = str(tmp_path / 'missing')
    with pytest.raises(ValueError, match='configured'):
        release.source_contract(config, release.LEGACY_200K_IMAGE)


def test_full_hash_cache_reuses_unchanged_files_and_rejects_same_size_edits(tmp_path, monkeypatch):
    content = b'A' * (1024**2 + 7)
    path = tmp_path / 'model.safetensors'; path.write_bytes(content)
    spec = model('example/target', 'revision', content)
    release.verify_folder(tmp_path, spec)
    original_open = Path.open
    with monkeypatch.context() as patch:
        patch.setattr(Path, 'open', lambda *args, **kwargs: pytest.fail('Unchanged tensor was rehashed'))
        release.verify_folder(tmp_path, spec)
    before = path.stat()
    path.write_bytes(b'B' * len(content))
    os.utime(path, ns=(before.st_atime_ns, before.st_mtime_ns))
    assert Path.open is original_open
    with pytest.raises(ValueError, match='does not match'):
        release.verify_folder(tmp_path, spec)


def test_inode_replacement_invalidates_verified_cache(tmp_path):
    path = tmp_path / 'model.safetensors'; path.write_bytes(b'valid')
    spec = model('example/target', 'revision', b'valid')
    release.verify_folder(tmp_path, spec)
    before = path.stat()
    other = tmp_path / 'replacement'; other.write_bytes(b'wrong')
    os.utime(other, ns=(before.st_atime_ns, before.st_mtime_ns))
    os.replace(other, path)
    with pytest.raises(ValueError, match='does not match'):
        release.verify_folder(tmp_path, spec)


def test_metadata_readiness_never_verifies_corrupt_local_weights(tmp_path, tiny_contracts, monkeypatch):
    config = {}
    for key, content in (('qwen38_nvfp4_target_dir', tiny_contracts['new']),
                         ('qwen38_mxfp4_draft_dir', tiny_contracts['draft']),
                         ('qwen38_w3rot_dir', b'X' * len(tiny_contracts['w3']))):
        folder = tmp_path / key; folder.mkdir()
        (folder / 'model.safetensors').write_bytes(content)
        config[key] = str(folder)
    runtime = SimpleNamespace(config=config)
    with monkeypatch.context() as patch:
        patch.setattr(Path, 'open', lambda *args, **kwargs: pytest.fail('Readiness opened checkpoint content'))
        selected = release.preflight(runtime, release.IMAGE, inspected(), 'w3a4', verify_content=False)
    assert selected['weights'] == 'w3a4'
    assert release._VERIFIED == {}
    assert not hasattr(runtime, '_qwen_volume_verifications')
    assert release.optional_status(runtime)['state'] == 'verification_required'
    with pytest.raises(ValueError, match='does not match'):
        release.preflight(runtime, release.IMAGE, inspected(), 'w3a4')
    assert not release.optional_status(runtime)['verified']
    (Path(config['qwen38_w3rot_dir']) / 'model.safetensors').unlink()
    with pytest.raises(ValueError, match='missing or incomplete'):
        release.preflight(runtime, release.IMAGE, inspected(), 'w3a4', verify_content=False)


def test_optional_status_returns_without_waiting_for_content_verification(tmp_path, tiny_contracts):
    (tmp_path / 'model.safetensors').write_bytes(tiny_contracts['w3'])
    release.verify_folder(tmp_path, release.OPTIONAL_COMPONENTS['w3a4'])
    runtime = SimpleNamespace(config={'qwen38_w3rot_dir': str(tmp_path)})
    locked, finish, returned = threading.Event(), threading.Event(), threading.Event()
    result = []

    def verify_in_progress():
        with release._VERIFY_LOCK:
            locked.set()
            finish.wait(timeout=5)

    def poll():
        try:
            result.append(release.optional_status(runtime))
        finally:
            returned.set()

    verifier = threading.Thread(target=verify_in_progress)
    reader = threading.Thread(target=poll)
    verifier.start()
    try:
        assert locked.wait(timeout=1)
        reader.start()
        assert returned.wait(timeout=1), 'Status polling waited behind full content verification'
        assert result[0]['state'] == 'verification_required'
        assert result[0]['installed'] and not result[0]['verified']
    finally:
        finish.set()
        verifier.join(timeout=2)
        if reader.ident is not None:
            reader.join(timeout=2)
    assert not verifier.is_alive() and not reader.is_alive()
    assert release.optional_status(runtime)['verified']


def test_metadata_volume_readiness_never_populates_or_refreshes_verified_cache(tmp_path, tiny_contracts, monkeypatch):
    runtime = SimpleNamespace(config={'qwen38_mxfp4_cache_volume': 'synthetic-cache'}, owner='test-owner')
    sources = release.source_contract(runtime.config, release.IMAGE)
    folders = {}
    for role, content in (('target', tiny_contracts['new']), ('draft', tiny_contracts['draft'])):
        folder = tmp_path / role; folder.mkdir()
        (folder / 'model.safetensors').write_bytes(content)
        folders[sources['paths'][role]] = str(folder)
    damaged = tmp_path / 'target/model.safetensors'
    damaged.write_bytes(b'X' * len(tiny_contracts['new']))
    flags = []

    def command(args, **kwargs):
        if args[:2] == ['volume', 'inspect']:
            return CompletedProcess(args, 0, '', '')
        assert args[0] == 'run' and '--network' in args and '--read-only' in args
        payload = json.loads(args[-1]); flags.append(payload['verify_content'])
        original = payload['checks']
        payload['checks'] = [(folders[name], files) for name, files in original]
        payload['cached'] = {folders[name]: value for name, value in payload['cached'].items()}
        with monkeypatch.context() as patch:
            patch.setattr(sys, 'argv', ['probe', json.dumps(payload)])
            output = io.StringIO()
            try:
                with redirect_stdout(output):
                    exec(compile(release._VOLUME_CHECK, '<synthetic-volume-check>', 'exec'), {})
            except ValueError:
                return CompletedProcess(args, 1, '', 'checksum or incomplete')
        result = json.loads(output.getvalue())
        return CompletedProcess(args, 0, json.dumps({name: result[folders[name]] for name, _ in original}), '')

    runtime.command = command
    release.preflight(runtime, release.IMAGE, inspected(), verify_content=False)
    assert not hasattr(runtime, '_qwen_volume_verifications') and release._VERIFIED == {}
    with pytest.raises(ValueError, match='exact verified'):
        release.preflight(runtime, release.IMAGE, inspected())
    assert not hasattr(runtime, '_qwen_volume_verifications')
    damaged.write_bytes(tiny_contracts['new'])
    release.preflight(runtime, release.IMAGE, inspected())
    verified = repr(runtime._qwen_volume_verifications)
    damaged.write_bytes(b'X' * len(tiny_contracts['new']))
    release.preflight(runtime, release.IMAGE, inspected(), verify_content=False)
    assert repr(runtime._qwen_volume_verifications) == verified
    with pytest.raises(ValueError, match='exact verified'):
        release.preflight(runtime, release.IMAGE, inspected())
    assert flags == [False, True, True, False, True]


@pytest.mark.parametrize('verify_content, expected_timeout', [(True, 1800), (False, 30)])
@pytest.mark.parametrize('failure', [RuntimeFailure('Docker did not respond in time.'), TimeoutExpired('docker', 30)])
def test_volume_probe_failure_removes_only_exact_owned_container(tiny_contracts, verify_content, expected_timeout, failure):
    cache = {('unrelated-image', 'other-volume', 'manifest'): {'already': 'verified'}}
    runtime = SimpleNamespace(config={'qwen38_mxfp4_cache_volume': 'synthetic-cache'}, owner='test-owner',
                              _qwen_volume_verifications=cache)
    calls, names = [], []
    identity = 'a' * 64

    def command(args, **kwargs):
        calls.append((args, kwargs))
        if args[:2] == ['volume', 'inspect']:
            return CompletedProcess(args, 0, '', '')
        if args[0] == 'run':
            names.append(args[args.index('--name') + 1])
            assert args[args.index('--label') + 1] == 'dev.paiton.studio.owner=test-owner'
            assert '--device' not in args and '--read-only' in args
            assert kwargs['timeout'] == expected_timeout
            raise failure
        if args[:2] == ['container', 'inspect']:
            assert args[2] == names[-1]
            return CompletedProcess(args, 0, json.dumps([{'Id': identity, 'Name': '/' + names[-1],
                'Config': {'Labels': {'dev.paiton.studio.owner': runtime.owner}}}]), '')
        assert args == ['rm', '--force', identity]
        return CompletedProcess(args, 0, '', '')

    runtime.command = command
    for _ in range(2):
        with pytest.raises(ValueError, match='did not finish'):
            release.preflight(runtime, release.IMAGE, inspected(), verify_content=verify_content)
    assert len(set(names)) == 2
    assert [args[0] for args, _ in calls] == ['volume', 'run', 'container', 'rm'] * 2
    assert runtime._qwen_volume_verifications is cache
    assert cache == {('unrelated-image', 'other-volume', 'manifest'): {'already': 'verified'}}


@pytest.mark.parametrize('mismatch', ['owner', 'name', 'identity', 'inspection'])
def test_volume_probe_cleanup_refuses_unconfirmed_container(tiny_contracts, mismatch):
    runtime = SimpleNamespace(config={'qwen38_mxfp4_cache_volume': 'synthetic-cache'}, owner='test-owner')
    names, calls = [], []

    def command(args, **kwargs):
        calls.append(args)
        if args[0] == 'volume':
            return CompletedProcess(args, 0, '', '')
        if args[0] == 'run':
            names.append(args[args.index('--name') + 1])
            raise RuntimeFailure('Docker did not respond in time.')
        assert args == ['container', 'inspect', names[-1]], 'Unexpected container removal'
        if mismatch == 'inspection':
            raise RuntimeFailure('Docker is unavailable.')
        record = {'Id': 'b' * 64, 'Name': '/' + names[-1],
                  'Config': {'Labels': {'dev.paiton.studio.owner': runtime.owner}}}
        if mismatch == 'owner': record['Config']['Labels']['dev.paiton.studio.owner'] = 'another-owner'
        if mismatch == 'name': record['Name'] = '/another-container'
        if mismatch == 'identity': record['Id'] = 'not-an-immutable-container-id'
        return CompletedProcess(args, 0, json.dumps([record]), '')

    runtime.command = command
    with pytest.raises(ValueError, match='did not finish'):
        release.preflight(runtime, release.IMAGE, inspected())
    assert [args[0] for args in calls] == ['volume', 'run', 'container']
    assert not hasattr(runtime, '_qwen_volume_verifications')


def test_volume_verifier_hashes_full_tensors_and_checks_cache_fingerprints(tmp_path, monkeypatch):
    path = tmp_path / 'model.safetensors'; path.write_bytes(b'good')
    spec = model('example/target', 'revision', b'good')
    payload = {'checks': [[str(tmp_path), spec['files']]], 'cached': {}}

    def check():
        monkeypatch.setattr(sys, 'argv', ['probe', json.dumps(payload)])
        output = io.StringIO()
        with redirect_stdout(output):
            exec(compile(release._VOLUME_CHECK, '<synthetic-volume-check>', 'exec'), {})
        return json.loads(output.getvalue())

    payload['cached'] = check()
    assert check() == payload['cached']
    before = path.stat(); path.write_bytes(b'evil')
    os.utime(path, ns=(before.st_atime_ns, before.st_mtime_ns))
    with pytest.raises(ValueError, match='checksum'):
        check()


def test_base_installer_needs_only_unified_runtime_target_and_draft(manager):
    installed(manager)
    assert {revision for revision, _ in manager.requests} == {'new', 'draft'}
    assert {args[-1] for args in manager.commands} == {release.IMAGE}
    config = manager.config
    assert 'qwen38_mxfp4_target_dir' not in config
    assert 'qwen38_w3rot_dir' not in config and release.W3_DEFAULT_KEY not in config
    assert config['qwen38_mxfp4_image'] == release.IMAGE
    before = list(manager.requests)
    release.install(manager, job(manager, 'again'))
    assert manager.requests == before


def test_base_upgrade_preserves_legacy_sources_and_reuses_verified_new_sources(manager):
    old = manager.root / 'existing-legacy'; old.mkdir()
    (old / 'model.safetensors').write_bytes(b'old target')
    manager.config['qwen38_mxfp4_target_dir'] = str(old)
    installed(manager)
    assert manager.config['qwen38_mxfp4_target_dir'] == str(old)
    assert release.preflight(manager.runtime, release.LEGACY_200K_IMAGE,
                             inspected(release.LEGACY_200K_IMAGE))['legacy']
    assert {revision for revision, _ in manager.requests} == {'new', 'draft'}
    manager.config['qwen38_mxfp4_image'] = release.PREVIOUS_65K_IMAGE
    current = job(manager, 'upgrade')
    manager.configure(dict(manager.config), current)
    before = list(manager.requests)
    release.install(manager, current)
    assert manager.requests == before
    assert manager.config['qwen38_mxfp4_image'] == release.IMAGE
    assert manager.config['qwen38_mxfp4_target_dir'] == str(old)


def test_optional_install_registers_after_verification_and_preserves_explicit_off(manager):
    installed(manager)
    baseline = dict(manager.config)
    current = job(manager, 'optional', 'w3a4')
    release.install(manager, current, component='w3a4')
    assert all(manager.config[key] == value for key, value in baseline.items())
    assert manager.config[release.W3_DEFAULT_KEY] is True
    state = release.optional_status(manager.runtime)
    assert state['installed'] and state['verified'] and state['enabled_default']
    manager.set_component_enabled('qwen38-mxfp4', 'w3a4', False)
    release.install(manager, current, component='w3a4')
    assert not release.optional_status(manager.runtime)['enabled_default']


def test_optional_hash_failure_never_changes_config_or_enables_default(manager, tiny_contracts):
    installed(manager)
    baseline = dict(manager.config)
    manager._open = lambda url, headers=None: Response(b'X' * len(tiny_contracts['w3']))
    with pytest.raises(SetupFailure, match='checksum'):
        release.install(manager, job(manager, 'optional', 'w3a4'), component='w3a4')
    assert manager.config == baseline
    assert not release.optional_status(manager.runtime)['verified']


def test_optional_download_resumes_through_existing_installer(manager, tiny_contracts):
    installed(manager)
    spec = release.OPTIONAL_COMPONENTS['w3a4']
    destination = manager.root / 'model-packages/qwen38-mxfp4/w3a4' / spec['revision'] / 'model.safetensors'
    part = manager.root / 'model-downloads' / (hashlib.sha256(str(destination.relative_to(manager.root)).encode()).hexdigest() + '.part')
    part.parent.mkdir(parents=True, exist_ok=True); part.write_bytes(tiny_contracts['w3'][:4])
    release.install(manager, job(manager, 'optional', 'w3a4'), component='w3a4')
    assert ('w3', 4) in manager.requests
    assert destination.read_bytes() == tiny_contracts['w3']


def test_cancelled_optional_install_keeps_base_and_no_default(manager):
    installed(manager)
    baseline = dict(manager.config)
    current = job(manager, 'optional', 'w3a4')
    with manager.store.connect() as db:
        db.execute('UPDATE setup_jobs SET cancel=1 WHERE id=?', (current['id'],))
    with pytest.raises(SetupCancelled):
        release.install(manager, current, component='w3a4')
    assert manager.config == baseline


def test_component_request_is_persistent_and_optional_work_keeps_base_ready(manager):
    installed(manager)
    current = manager.install('qwen38-mxfp4', 'w3a4')
    assert current['component'] == 'w3a4'
    assert manager.install('qwen38-mxfp4', 'w3a4')['id'] == current['id']
    package = next(item for item in manager.snapshot(force=True)['tools'] if item['id'] == 'qwen38-mxfp4')
    assert package['state'] == 'ready' and package['files_ready']
    assert package['optional_components'][0]['state'] == 'installing'
    restored = SetupManager(manager.store, manager.runtime, config_path=manager.config_path)
    assert restored.job(current['id'])['component'] == 'w3a4'
    with pytest.raises(ValueError):
        manager.install('qwen38', 'w3a4')
    with pytest.raises(ValueError):
        manager.install('qwen38-mxfp4', '../other')


def test_unverified_optional_files_cannot_be_enabled(manager, tiny_contracts):
    directory = manager.root / 'external'; directory.mkdir()
    (directory / 'model.safetensors').write_bytes(tiny_contracts['w3'])
    manager.config['qwen38_w3rot_dir'] = str(directory)
    state = release.optional_status(manager.runtime)
    assert state['installed'] and not state['verified'] and state['state'] == 'verification_required'
    with pytest.raises(ValueError, match='verify'):
        manager.set_component_enabled('qwen38-mxfp4', 'w3a4', True)
    release.verify_folder(directory, release.OPTIONAL_COMPONENTS['w3a4'])
    assert manager.set_component_enabled('qwen38-mxfp4', 'w3a4', True)['enabled_default']


def test_stored_optional_default_remains_visible_and_can_be_disabled_with_cold_cache(manager):
    installed(manager)
    release.install(manager, job(manager, 'optional', 'w3a4'), component='w3a4')
    release._VERIFIED.clear()
    state = release.optional_status(manager.runtime)
    assert state['enabled_default'] and not state['verified']
    assert state['state'] == 'verification_required'
    with pytest.raises(ValueError, match='verify'):
        manager.set_component_enabled('qwen38-mxfp4', 'w3a4', True)
    state = manager.set_component_enabled('qwen38-mxfp4', 'w3a4', False)
    assert not state['enabled_default'] and not state['verified']


def test_optional_download_uses_only_its_own_disk_reservation(manager):
    installed(manager)
    system = manager._system()
    manager._system = lambda: {**system, 'disk_free_bytes': 15_000_000_000,
                              'docker_disk_free_bytes': 0}
    package = next(item for item in manager.snapshot(force=True)['tools'] if item['id'] == 'qwen38-mxfp4')
    assert package['files_ready']
    component = package['optional_components'][0]
    assert component['can_install'] and not component['can_toggle']
    assert manager.install('qwen38-mxfp4', 'w3a4')['component'] == 'w3a4'


def test_readiness_and_optional_setup_do_not_require_legacy_sources(manager):
    installed(manager)
    manager.runtime.preflight = lambda request, **kwargs: release.preflight(manager.runtime, release.IMAGE, inspected(), **kwargs)
    assert SetupManager._readiness(manager, 'qwen38-mxfp4')[0]
    assert 'qwen38_mxfp4_target_dir' not in manager.config
    assert {args[-1] for args in manager.commands} == {release.IMAGE}
    selected = release.preflight(manager.runtime, release.IMAGE, inspected())
    assert not selected['legacy']
    component = manager._components('qwen38-mxfp4', manager._catalog()['qwen38-mxfp4'], manager._system(), manager.jobs())[0]
    assert component['can_install']
    (Path(manager.config['qwen38_nvfp4_target_dir']) / 'model.safetensors').unlink()
    assert not SetupManager._readiness(manager, 'qwen38-mxfp4')[0]


def test_setup_polling_skips_hashes_but_optional_install_still_verifies_base(manager, monkeypatch):
    installed(manager)
    target = Path(manager.config['qwen38_nvfp4_target_dir']) / 'model.safetensors'
    target.write_bytes(b'X' * target.stat().st_size)
    release._VERIFIED.clear()
    manager.runtime.preflight = lambda request, **kwargs: release.preflight(manager.runtime, release.IMAGE, inspected(), **kwargs)
    with monkeypatch.context() as patch:
        patch.setattr(Path, 'open', lambda *args, **kwargs: pytest.fail('Setup polling read checkpoint content'))
        ready, message = SetupManager._readiness(manager, 'qwen38-mxfp4')
        component = manager._components('qwen38-mxfp4', manager._catalog()['qwen38-mxfp4'],
                                        manager._system(), manager.jobs())[0]
    assert ready and 'hashes are checked before loading' in message
    assert component['can_install'] and not component['can_toggle']
    assert release._VERIFIED == {}
    before = list(manager.requests)
    with pytest.raises(ValueError, match='does not match'):
        release.install(manager, job(manager, 'optional', 'w3a4'), component='w3a4')
    assert manager.requests == before and 'qwen38_w3rot_dir' not in manager.config
    with pytest.raises(ValueError, match='verify'):
        manager.set_component_enabled('qwen38-mxfp4', 'w3a4', True)


def test_ready_qwen_verify_action_repairs_same_size_corrupt_base_with_pinned_download(manager, tiny_contracts):
    installed(manager)
    target = Path(manager.config['qwen38_nvfp4_target_dir']) / 'model.safetensors'
    target.write_bytes(b'X' * target.stat().st_size)
    release._VERIFIED.clear()
    release.preflight(manager.runtime, release.IMAGE, inspected(), verify_content=False)
    with pytest.raises(ValueError, match='does not match'):
        release.preflight(manager.runtime, release.IMAGE, inspected())
    tool = next(item for item in manager.snapshot(force=True)['tools'] if item['id'] == 'qwen38-mxfp4')
    assert tool['files_ready'] and tool['can_verify'] and not tool['can_install']
    current = manager.install('qwen38-mxfp4')
    assert current['state'] == 'queued' and current['component'] is None
    assert current['message'].startswith('Verification requested.')
    before = len(manager.requests)
    release.install(manager, current)
    assert manager.requests[before:] == [('new', 0)]
    assert target.read_bytes() == tiny_contracts['new']
    release.preflight(manager.runtime, release.IMAGE, inspected())
    assert 'qwen38_w3rot_dir' not in manager.config and release.W3_DEFAULT_KEY not in manager.config
