import hashlib
import json
from pathlib import Path
from subprocess import CompletedProcess
from types import SimpleNamespace

import pytest

from studio import setup_media
from studio.setup_catalog import CODER, FLUX, H3, PACKAGES


class Manager:
    def __init__(self, root):
        self.root = root
        root.mkdir(exist_ok=True)
        (root/'owner').write_text('studio-test-owner')
        self.calls, self.downloads, self.states, self.config = [], [], [], {}
        self.identity = 'a'*64
    def run(self, command, job, timeout=3600):
        self.calls.append((command, job))
        if command[1] == 'inspect':
            return CompletedProcess(command, 1, '', '')
        return CompletedProcess(command, 0, self.identity if command[1] == 'create' else '', '')
    def download(self, url, destination, size, checksum, job):
        self.downloads.append((url, destination, size, checksum))
        destination.parent.mkdir(parents=True, exist_ok=True)
        return destination
    def update(self, job, state, message, **details):
        self.states.append(state)
    def check_cancel(self, job):
        pass
    def configure(self, updates, job):
        self.config.update(updates)


def test_all_integrated_models_have_pinned_install_recipes():
    assert {key for key,p in PACKAGES.items() if p['can_install']} == {'flux','h3','qwen38','qwen38-mxfp4','qwen-coder','gptoss','wan','fastwan','minicpm5-2b'}
    assert all('@sha256:' in p['image'] for p in PACKAGES.values() if p['can_install'] and p['installer'] not in ('wan','fastwan'))
    assert all(PACKAGES[key]['installer']==key and PACKAGES[key]['image'] is None for key in ('wan','fastwan'))
    assert sum(item['bytes'] for item in H3['files']) == 35917312271
    assert all(len(item['sha256']) == 64 for item in H3['files']+H3['source_files'])
    assert {p for item in H3['files'] for p in item['profiles']} >= {'turbo4', 'turbo8'}


def test_h3_setup_builds_from_pinned_public_source_and_never_loads_gpu(tmp_path):
    manager = Manager(tmp_path)
    setup_media.install_media(manager, {'id': 'install-video', 'package': 'h3'})
    build = next(command for command, _ in manager.calls if command[1] == 'build')
    assert 'PAITON_H3_BASE_IMAGE='+H3['base_image'] in build
    assert 'dev.paiton.distribution=local-assembly-only' in build
    assert all('--device' not in command for command, _ in manager.calls)
    probe = next(command for command, _ in manager.calls if command[1] == 'run')
    assert probe[probe.index('--network')+1] == 'none'
    assert '--read-only' in probe and 'first_frame' in probe[-1]
    assert setup_media.SETUP_OWNER_LABEL+'=studio-test-owner' in probe
    assert len(manager.downloads) == len(H3['source_files'])+len(H3['files'])
    assert all(str(destination).startswith(str(tmp_path)) for _, destination, _, _ in manager.downloads)
    assert manager.config['h3_package_dir'].endswith(H3['source_revision'])
    assert manager.config['h3_models_dir'].endswith('/models')


def test_cleanup_requires_both_labels_and_exact_id(tmp_path):
    manager = Manager(tmp_path)
    def run(command, job, timeout=3600):
        manager.calls.append((command, job))
        data = {'Id': manager.identity, 'Config': {'Labels': {setup_media.SETUP_OWNER_LABEL: 'another-studio', setup_media.SETUP_LABEL: 'test'}}}
        return CompletedProcess(command, 0, json.dumps(data), '')
    manager.run = run
    setup_media._cleanup_container(manager, 'some-container', 'studio-test-owner', 'test')
    assert [c[1] for c, _ in manager.calls] == ['inspect']


def preparation_manager(tmp_path, monkeypatch, fail=False):
    manager = Manager(tmp_path)
    source = tmp_path/'source'; source.mkdir()
    destination = tmp_path/'prepared/revision'; destination.parent.mkdir()
    job = {'id': 'prepare-test', 'package': 'flux'}
    class Lease:
        held = False
        closed = False
        def acquire(self): self.held = True; return True
        def close(self): self.held = False; self.closed = True
    lease = Lease()
    monkeypatch.setattr(setup_media, 'gpu_lease', lambda: lease)
    monkeypatch.setattr(setup_media, 'gpu_status', lambda: {'available': True, 'supported': True, 'driver_available': True, 'gpu_count': 1, 'name': 'AMD Radeon AI PRO R9700', 'architecture': 'gfx1201', 'total': 32*1024**3})
    original_stat = setup_media.os.stat
    monkeypatch.setattr(setup_media.os, 'stat', lambda path, *args, **kwargs: SimpleNamespace(st_gid=100) if str(path) == '/dev/kfd' else original_stat(path, *args, **kwargs))
    base = manager.run
    def run(command, current_job, timeout=3600):
        if command[1] == 'start':
            manager.calls.append((command, current_job))
            assert lease.held
            if fail: raise RuntimeError('cancelled while preparing')
            stage = next(destination.parent.glob('.preparing-*'))/'runtime'
            stage.mkdir()
            value = b'qualified tensors'
            (stage/'weights.bin').write_bytes(value)
            (stage/'conversion.json').write_text(json.dumps({'source_revision': FLUX['revision'], 'source_model': FLUX['repository'], 'format_version': 1, 'files': {'weights.bin': {'size_bytes': len(value), 'sha256': hashlib.sha256(value).hexdigest()}}}))
            return CompletedProcess(command, 0, '', '')
        if command[1] == 'inspect':
            manager.calls.append((command, current_job))
            data = {'Id': manager.identity, 'Config': {'Labels': {setup_media.SETUP_OWNER_LABEL: 'studio-test-owner', setup_media.SETUP_LABEL: job['id']}}}
            return CompletedProcess(command, 0, json.dumps(data), '')
        return base(command, current_job, timeout)
    manager.run = run
    return manager, job, source, destination, lease


def test_flux_preparation_holds_shared_lease_and_publishes_only_verified_tensors(tmp_path, monkeypatch):
    manager, job, source, destination, lease = preparation_manager(tmp_path, monkeypatch)
    setup_media._prepare_flux(manager, job, source, destination)
    assert (destination/'conversion.json').is_file()
    assert lease.closed and not lease.held
    create = next(command for command, _ in manager.calls if command[1] == 'create')
    assert create[create.index('--network')+1] == 'none'
    assert '--device' in create and 'HF_HUB_OFFLINE=1' in create
    assert 'type=bind,src='+str(source)+',dst=/source,readonly' in create
    assert create[-7:] == [FLUX['tools_image'], '-m', 'sdnq_tool.convert', '--snapshot', '/source', '--output', '/prepared/runtime']
    stop = next((command, current_job) for command, current_job in manager.calls if command[1] == 'stop')
    assert stop[0][-1] == manager.identity and stop[1] is None
    assert manager.states == ['waiting_for_gpu', 'preparing', 'verifying']


def test_cancelled_preparation_releases_owned_gpu_and_never_publishes_cache(tmp_path, monkeypatch):
    manager, job, source, destination, lease = preparation_manager(tmp_path, monkeypatch, fail=True)
    with pytest.raises(RuntimeError, match='cancelled'): setup_media._prepare_flux(manager, job, source, destination)
    assert lease.closed and not destination.exists()
    assert any(command[1] == 'rm' and command[-1] == manager.identity for command, _ in manager.calls)


def test_preparation_waits_for_other_gpu_users_and_can_cancel_without_launch(tmp_path, monkeypatch):
    manager = Manager(tmp_path)
    class Lease:
        def acquire(self): return False
    monkeypatch.setattr(setup_media, 'gpu_lease', Lease)
    def cancel(job): raise RuntimeError('cancelled while waiting')
    manager.check_cancel = cancel
    with pytest.raises(RuntimeError, match='waiting'): setup_media._prepare_flux(manager, {'id': 'wait'}, tmp_path/'source', tmp_path/'prepared')
    assert not manager.calls


def test_coder_setup_populates_own_snapshot_and_preserves_shared_cache(tmp_path):
    manager = Manager(tmp_path)
    manager.config['hf_hub_dir'] = '/other/shared/cache'
    files = [{'rfilename': name, 'size': 1, 'blobId': 'f'*40} for name in ('config.json', 'tokenizer_config.json', 'tokenizer.json')]
    files.append({'rfilename': 'model.safetensors', 'size': 42, 'lfs': {'size': 42, 'sha256': 'a'*64}})
    manager.read_json = lambda url, job: {'sha': CODER['revision'], 'siblings': files}
    setup_media.install_media(manager, {'id': 'coder', 'package': 'qwen-coder'})
    assert manager.config['hf_hub_dir'] == '/other/shared/cache'
    assert manager.config['writing_hub_dir'] == str(tmp_path/'model-packages/qwen-coder/hub')
    assert manager.config['writing_image'] == CODER['image']
    assert all('/snapshots/'+CODER['revision']+'/' in str(path) for _, path, _, _ in manager.downloads)
    assert manager.downloads[0][-1] == 'git:'+'f'*40
    assert all('--device' not in command for command, _ in manager.calls)


def test_recovery_reports_docker_failure_and_only_succeeds_after_verified_cleanup(tmp_path):
    manager = Manager(tmp_path)
    manager.run = lambda command, job, timeout=30: CompletedProcess(command, 1, '', '')
    assert setup_media.recover_setup(manager) is False
    manager.run = lambda command, job, timeout=30: CompletedProcess(command, 0, '', '')
    assert setup_media.recover_setup(manager) is True
    calls = []
    def run(command, job, timeout=30):
        calls.append(command)
        if command[1] == 'ps':
            return CompletedProcess(command, 0, manager.identity, '')
        if command[1] == 'inspect':
            data = {'Id': manager.identity, 'Config': {'Labels': {setup_media.SETUP_OWNER_LABEL: 'studio-test-owner', setup_media.SETUP_LABEL: 'past-setup'}}}
            return CompletedProcess(command, 0, json.dumps(data), '')
        return CompletedProcess(command, 0, '', '')
    manager.run = run
    assert setup_media.recover_setup(manager) is True
    assert any(command[1] == 'rm' and command[-1] == manager.identity for command in calls)
