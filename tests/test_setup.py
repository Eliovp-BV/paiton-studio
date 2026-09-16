"""Setup regression tests use temporary data, mock HTTP and mock Docker only."""
import hashlib
import io
import json
import subprocess
import threading
from types import SimpleNamespace

import pytest

from studio import setup
from studio.setup import SetupManager, SetupCancelled, SetupFailure, _trusted_url
from studio.store import Store


class Response(io.BytesIO):
    def __init__(self, content, status=200, headers=None):
        super().__init__(content)
        self.status = status
        self.headers = {'Content-Length': str(len(content)), **(headers or {})}

    def getcode(self):
        return self.status


@pytest.fixture
def manager(tmp_path):
    store = Store(tmp_path / 'data')
    runtime = SimpleNamespace(config={}, command=lambda *a, **k: subprocess.CompletedProcess([], 1, '', ''))
    result = SetupManager(store, runtime, config_path=tmp_path / 'config.local.json')
    result._open = lambda *a, **k: pytest.fail('Unexpected network request')
    result.run = lambda *a, **k: pytest.fail('Unexpected process launch')
    return result


def queued(manager, package='qwen38', state='queued'):
    with manager.store.connect() as db:
        db.execute('INSERT INTO setup_jobs(id,package,state,message,created,updated) VALUES(?,?,?,?,?,?)',
                   ('job', package, state, 'Test setup request', 1, 1))
    return manager.job('job')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def part_path(manager, destination):
    return manager.root / 'model-downloads' / (digest(str(destination.relative_to(manager.root)).encode()) + '.part')


def system_ready():
    return dict(ready=True, docker=True, driver=True, supported_gpu=True, disk_free_bytes=100_000_000_000,
                checks=[], message='Ready', gpu=dict(supported=True, driver_available=True, gpu_count=1,
                    name='AMD Radeon AI PRO R9700', architecture='gfx1201', total=32*1024**3))


def test_snapshot_is_offline_and_probe_results_are_cached(manager):
    calls = []
    manager._system = lambda: calls.append('system') or system_ready()
    manager._readiness = lambda package: calls.append(package) or (False, 'Not installed')
    first = manager.snapshot()
    queued(manager)
    second = manager.snapshot()
    assert calls.count('system') == 1
    assert len(first['jobs']) == 0 and len(second['jobs']) == 1
    assert next(t for t in first['tools'] if t['id'] == 'qwen38')['can_install']
    assert next(t for t in second['tools'] if t['id'] == 'qwen38')['state'] == 'installing'


def test_missing_system_and_disk_have_specific_states(manager):
    manager._system = lambda: {**system_ready(), 'docker': False, 'ready': False, 'message': 'Install Docker'}
    snapshot = manager.snapshot()
    assert all(t['state'] == 'system_required' and not t['can_install'] for t in snapshot['tools'])
    assert snapshot['system']['message'] == 'Install Docker'
    manager._system = lambda: {**system_ready(), 'disk_free_bytes': 1}
    manager._readiness = lambda package: (False, 'Missing files')
    assert all(t['state'] == 'insufficient_disk' for t in manager.snapshot(force=True)['tools'])


def test_install_requires_supported_available_package_and_is_idempotent(manager):
    manager._system = system_ready
    manager._readiness = lambda package: (False, 'Missing files')
    with pytest.raises(ValueError):
        manager.install('../../elsewhere')
    with pytest.raises(ValueError):
        manager.install('ornith')
    first = manager.install('qwen38')
    assert first['state'] == 'queued'
    assert manager.install('qwen38')['id'] == first['id']
    assert len(manager.jobs()) == 1


def test_consumer_setup_excludes_unreleased_candidates_but_keeps_supported_tools(manager):
    public = {'minicpm5-2b', 'flux', 'h3', 'qwen-coder', 'qwen38', 'qwen38-mxfp4', 'gptoss', 'wan', 'fastwan'}
    manager._system = system_ready
    probes = []
    manager._readiness = lambda package: probes.append(package) or (False, 'Missing files')
    tools = manager.snapshot()['tools']
    assert set(manager._catalog()) == {item['id'] for item in tools} == public
    assert set(probes) == public
    assert all(item['can_install'] for item in tools)
    assert manager.jobs() == []

    # A supported package stays visible when its files are installed on a GPU
    # that cannot run it. Only unpublished experiments disappear.
    manager._system = lambda: {**system_ready(), 'gpu': {
        **system_ready()['gpu'], 'name': 'AMD Radeon RX 9070 XT', 'total': 16 * 1024**3}}
    manager._readiness = lambda package: (True, 'Installed')
    tools = manager.snapshot(force=True)['tools']
    assert {item['id'] for item in tools} == public
    assert all(item['files_ready'] and not item['generation_ready'] for item in tools)
    assert all(not item['compatibility']['compatible'] for item in tools)


@pytest.mark.parametrize('package', ['qwen3-4b', 'ornith'])
def test_unreleased_candidate_install_is_rejected_before_host_or_download_work(manager, package):
    manager._system = lambda: pytest.fail('An unreleased candidate must not probe or prepare the host')
    with pytest.raises(ValueError, match='Choose a supported local model package'):
        manager.install(package)
    assert manager.jobs() == []


def test_queued_cancel_does_not_run_download(manager):
    job = queued(manager)
    assert manager.cancel(job['id'])['state'] == 'cancelled'
    with pytest.raises(SetupCancelled):
        manager.check_cancel(job)


def test_complete_download_is_verified_and_reused_without_network(manager):
    job = queued(manager)
    data = b'verified model data'
    destination = manager.root / 'model-packages/qwen38/model.safetensors'
    manager._open = lambda *a, **k: Response(data)
    assert manager.download('https://huggingface.co/test', destination, len(data), digest(data), job) == destination
    assert destination.read_bytes() == data
    manager._open = lambda *a, **k: pytest.fail('Verified file should be reused')
    manager.update(job, 'downloading', 'Retry', completed_bytes=0)
    manager.download('https://huggingface.co/test', destination, len(data), digest(data), job)
    assert manager.job('job')['completed_bytes'] == len(data)


def test_resume_checks_content_range_and_appends_exact_bytes(manager):
    job = queued(manager)
    data = b'abcdefghijk'
    destination = manager.root / 'model-packages/model.bin'
    part = part_path(manager, destination)
    part.parent.mkdir(parents=True)
    part.write_bytes(data[:4])
    requests = []
    manager._open = lambda url, headers: requests.append(headers) or Response(data[4:], 206, {'Content-Range': 'bytes 4-10/11'})
    manager.download('https://huggingface.co/test', destination, len(data), digest(data), job)
    assert requests == [{'Range': 'bytes=4-'}]
    assert destination.read_bytes() == data and not part.exists()


def test_resume_ignored_range_restarts_instead_of_duplicating(manager):
    job = queued(manager)
    data = b'whole file'
    destination = manager.root / 'model-packages/model.bin'
    part = part_path(manager, destination)
    part.parent.mkdir(parents=True)
    part.write_bytes(data[:3])
    manager._open = lambda *a, **k: Response(data)
    manager.download('https://huggingface.co/test', destination, len(data), digest(data), job)
    assert destination.read_bytes() == data


def test_bad_resume_range_preserves_original_partial(manager):
    job = queued(manager)
    data = b'abcdefghijk'
    destination = manager.root / 'model-packages/model.bin'
    part = part_path(manager, destination)
    part.parent.mkdir(parents=True)
    part.write_bytes(data[:4])
    manager._open = lambda *a, **k: Response(data[4:], 206, {'Content-Range': 'bytes 0-6/11'})
    with pytest.raises(SetupFailure, match='resume range'):
        manager.download('https://huggingface.co/test', destination, len(data), digest(data), job)
    assert part.read_bytes() == data[:4] and not destination.exists()


def test_checksum_mismatch_never_publishes_or_configures(manager):
    job = queued(manager)
    destination = manager.root / 'model-packages/model.bin'
    manager._open = lambda *a, **k: Response(b'bad')
    with pytest.raises(SetupFailure, match='checksum'):
        manager.download('https://huggingface.co/test', destination, 3, digest(b'yes'), job)
    assert not destination.exists() and not part_path(manager, destination).exists()
    assert not manager.config_path.exists()


def test_download_blocks_symlink_escape_and_untrusted_sources(manager, tmp_path):
    job = queued(manager)
    outside = tmp_path / 'outside'
    outside.mkdir()
    (manager.root / 'escape').symlink_to(outside, target_is_directory=True)
    with pytest.raises(ValueError):
        manager.download('https://huggingface.co/test', manager.root / 'escape/model', 1, digest(b'x'), job)
    for url in ['http://huggingface.co/test', 'https://huggingface.co.evil.test/file', 'https://localhost/model', 'https://user:pass@huggingface.co/file']:
        with pytest.raises(SetupFailure):
            _trusted_url(url)
    assert _trusted_url('https://cas-bridge.xethub.hf.co/object')


def test_git_blob_checksum_for_pinned_small_source_files(manager):
    job = queued(manager)
    data = b'{"name":"tokenizer"}'
    checksum = hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()
    manager._open = lambda *a, **k: Response(data)
    destination = manager.root / 'model-packages/tokenizer.json'
    manager.download('https://huggingface.co/test', destination, len(data), 'git:' + checksum, job)
    assert destination.read_bytes() == data


def test_configuration_merge_preserves_existing_host_paths(manager):
    job = queued(manager)
    manager.config_path.write_text(json.dumps({'flux_model_dir': '/existing/prepared'}))
    manager.configure({'qwen38_model_dir': str(manager.root / 'model-packages/qwen38')}, job)
    saved = json.loads(manager.config_path.read_text())
    assert saved['flux_model_dir'] == '/existing/prepared'
    assert manager.runtime.config['qwen38_model_dir'] == saved['qwen38_model_dir']


def test_invalid_configuration_is_not_overwritten(manager):
    job = queued(manager)
    manager.config_path.write_text('unfinished edit')
    with pytest.raises(SetupFailure, match='configuration'):
        manager.configure({'qwen38_model_dir': 'new'}, job)
    assert manager.config_path.read_text() == 'unfinished edit'
    assert not manager.runtime.config


def test_new_config_preserves_already_connected_runtime_sources(manager):
    job = queued(manager)
    manager.config['h3_models_dir'] = '/existing/video'
    manager.configure({'qwen38_model_dir': '/new/owned/writer'}, job)
    assert json.loads(manager.config_path.read_text())['h3_models_dir'] == '/existing/video'


def test_cpu_download_allowed_before_gpu_driver_setup(manager):
    manager._system = lambda: {**system_ready(), 'ready': False, 'can_download': True, 'driver': False, 'supported_gpu': False, 'message': 'Install Radeon driver'}
    manager._readiness = lambda package: (False, 'No files')
    tools = {t['id']: t for t in manager.snapshot()['tools']}
    assert tools['qwen38']['can_install'] and tools['h3']['can_install']
    assert not tools['flux']['can_install'] and not tools['qwen38']['generation_ready']


def test_separate_docker_disk_space_is_checked(manager):
    manager._system = lambda: {**system_ready(), 'docker_disk_free_bytes': 1}
    manager._readiness = lambda package: (False, 'No files')
    tools = manager.snapshot()['tools']
    assert all(not t['can_install'] and 'Docker storage' in t['message'] for t in tools)


def test_model_eligibility_is_distinct_from_download_and_installed_files(manager):
    manager._system = lambda: {**system_ready(), 'gpu': {**system_ready()['gpu'], 'name': 'AMD Radeon RX 9070 XT', 'total': 16*1024**3}}
    manager._readiness = lambda package: (False, 'No files')
    tools = {t['id']: t for t in manager.snapshot()['tools']}
    assert tools['h3']['compatibility']['required_vram_gib'] > 16
    assert tools['h3']['compatibility']['detected_vram_gib'] == 16
    assert not tools['h3']['generation_ready'] and tools['h3']['can_install']
    assert not tools['flux']['can_install']  # Current image code also requires the qualified device identity.
    assert 'R9700' in tools['flux']['compatibility']['reason']


def test_qwen_install_only_fetches_pinned_files_and_registers_after_verification(manager, monkeypatch):
    job = queued(manager)
    files = {name: ('fixture ' + name).encode() for name in setup.CHAT_PACKAGES['qwen38']['runtime_files']}
    checkpoint = files['model.safetensors']
    monkeypatch.setattr(setup, 'QWEN_CHECKPOINT_BYTES', len(checkpoint))
    monkeypatch.setattr(setup, 'QWEN_CHECKPOINT_SHA256', digest(checkpoint))
    siblings = []
    for name, data in files.items():
        item = {'rfilename': name, 'size': len(data), 'blobId': hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()}
        if name == 'model.safetensors':
            item['lfs'] = {'size': len(data), 'sha256': digest(data)}
        siblings.append(item)
    commands = []
    requests = []
    manager.run = lambda command, *a, **k: commands.append(command) or subprocess.CompletedProcess(command, 0, '', '')
    manager.read_json = lambda url, *a, **k: requests.append(url) or {'sha': setup.QWEN_REVISION, 'siblings': siblings}
    manager._open = lambda url, *a, **k: requests.append(url) or Response(files[url.rsplit('/', 1)[-1]])
    manager._qwen38(job)
    assert commands == [['docker', 'pull', setup.QWEN_IMAGE]]
    assert all(setup.QWEN_REVISION in url for url in requests)
    assert all('/api/models/' in url or '/resolve/' in url for url in requests)
    final = manager.root / 'model-packages/qwen38' / setup.QWEN_REVISION
    assert all((final / name).read_bytes() == data for name, data in files.items())
    assert manager.config['qwen38_model_dir'] == str(final)
    assert manager.config['qwen38_image'] == setup.QWEN_IMAGE


def test_qwen_rejects_manifest_checkpoint_mismatch_before_files(manager):
    job = queued(manager)
    manager.run = lambda *a, **k: subprocess.CompletedProcess([], 0, '', '')
    manager.read_json = lambda *a, **k: {'sha': 'wrong', 'siblings': []}
    with pytest.raises(SetupFailure, match='revision'):
        manager._qwen38(job)
    assert not manager.config_path.exists()


def test_restart_marks_interrupted_without_resuming_download(manager, monkeypatch):
    from studio import setup_media
    monkeypatch.setattr(setup_media, 'recover_setup', lambda manager: True)
    queued(manager, state='downloading')
    manager.start()
    try:
        assert manager.job('job')['state'] == 'interrupted'
    finally:
        manager.close()


def test_setup_retries_failed_startup_recovery_before_installing(manager, monkeypatch):
    from studio import setup_media
    calls = []
    completed = threading.Event()
    def recover(current):
        calls.append('recover')
        return len(calls) > 1  # Docker unavailable at startup, available for the job.
    monkeypatch.setattr(setup_media, 'recover_setup', recover)
    manager._system = system_ready
    manager._qwen38 = lambda job: calls.append('install')
    original_update = manager.update
    def update(job, state, message, **details):
        original_update(job, state, message, **details)
        if state in setup.TERMINAL:
            completed.set()
    manager.update = update
    queued(manager)
    manager.start()
    try:
        assert manager._needs_recovery
        assert completed.wait(3)
        assert calls == ['recover', 'recover', 'install']
        assert not manager._needs_recovery
        assert manager.job('job')['state'] == 'completed'
    finally:
        manager.close()


def test_failed_recovery_prevents_new_install_and_keeps_retry_flag(manager, monkeypatch):
    from studio import setup_media
    finished = threading.Event()
    monkeypatch.setattr(setup_media, 'recover_setup', lambda manager: False)
    manager._system = system_ready
    manager._qwen38 = lambda job: pytest.fail('Installation must wait for successful ownership recovery')
    original_update = manager.update
    def update(job, state, message, **details):
        original_update(job, state, message, **details)
        if state in setup.TERMINAL:
            finished.set()
    manager.update = update
    queued(manager)
    manager.start()
    try:
        assert finished.wait(3)
        assert manager._needs_recovery
        assert manager.job('job')['state'] == 'failed'
        assert 'Restore Docker access' in manager.job('job')['message']
    finally:
        manager.close()


def test_process_cancellation_stops_only_the_launched_process(manager, monkeypatch):
    job = queued(manager)
    stopped = []
    class Process:
        stdout = io.BytesIO(b'local output')
        returncode = None
        def poll(self): return self.returncode
        def terminate(self): stopped.append('terminate'); self.returncode = -15
        def wait(self, timeout=None): return self.returncode
    process = Process()
    monkeypatch.setattr(setup.subprocess, 'Popen', lambda *a, **k: process)
    calls = []
    def check(job):
        calls.append(job)
        if len(calls) > 1:
            raise SetupCancelled('cancelled')
    manager.check_cancel = check
    with pytest.raises(SetupCancelled):
        SetupManager.run(manager, ['docker', 'pull', setup.QWEN_IMAGE], job)
    assert stopped == ['terminate']
