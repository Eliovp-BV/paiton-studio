"""Release, download, routing and lifecycle contracts; CPU fixtures are not inference."""
import hashlib
import json
from pathlib import Path
from subprocess import CompletedProcess
from types import SimpleNamespace

import pytest

from studio import qwen_mxfp4 as release
from studio.chat_adapters import writing_body
from studio.preferences import SettingsInput, get_settings, resolve_profile, save_settings
from studio.registry import compatibility, profile
from studio.runtime import Runtime, RuntimeFailure
from studio.store import Store
from test_qwen_reuse import qwen_runtime


def device():
    return dict(name='AMD Radeon AI PRO R9700', architecture='gfx1201', driver_available=True,
                gpu_count=1, total=32 * 1024**3)


def inspected(identity=release.IMAGE_ID):
    return json.dumps([{'Id': identity}])


def test_image_pin_accepts_classic_docker_config_ids_only_with_exact_repo_digest():
    release.verify_image(json.dumps([{'Id': 'sha256:config-object', 'RepoDigests': [release.IMAGE]}]))
    with pytest.raises(ValueError, match='pinned'):
        release.verify_image(json.dumps([{'Id': 'sha256:config-object', 'RepoDigests': ['ghcr.io/eliovp/paiton-vllm-plugin@sha256:other-release']}]))


@pytest.mark.parametrize('role,suffix', [('write', 'writing'), ('website', 'website'), ('chat', 'chat'), ('code', 'chat')])
def test_default_uses_new_release_and_preserves_explicit_choices(tmp_path, monkeypatch, role, suffix):
    store = Store(tmp_path)
    monkeypatch.setattr('studio.preferences.gpu_status', device)
    runtime = SimpleNamespace(preflight=lambda request: release.IMAGE)
    assert resolve_profile(store, runtime, role)['id'] == 'qwen38-mxfp4-' + suffix
    legacy = {'write': 'qwen38-writing', 'website': 'qwen38-website', 'chat': 'gptoss-chat', 'code': 'gptoss-chat'}[role]
    save_settings(store, SettingsInput(defaults={role: legacy}))
    assert resolve_profile(store, runtime, role)['id'] == legacy
    assert get_settings(store)['defaults'][role] == legacy


@pytest.mark.parametrize('role,legacy', [('write', 'qwen38-writing'), ('website', 'qwen38-website'), ('chat', 'gptoss-chat')])
def test_missing_new_package_preserves_existing_recommended_fallback(tmp_path, monkeypatch, role, legacy):
    monkeypatch.setattr('studio.preferences.gpu_status', device)
    def preflight(request):
        if request['profile']['package'] == 'qwen38-mxfp4': raise RuntimeFailure('Not installed')
    runtime = SimpleNamespace(preflight=preflight)
    store = Store(tmp_path)
    assert resolve_profile(store, runtime, role)['id'] == legacy
    with pytest.raises(RuntimeFailure, match='Not installed'):
        resolve_profile(store, runtime, role, 'qwen38-mxfp4-' + {'write': 'writing', 'website': 'website', 'chat': 'chat'}[role])


def test_qualified_profile_keeps_context_sampling_and_hardware_contract():
    p = profile('qwen38-mxfp4-chat', 'write', 'chat')
    body = writing_body({'profile': p, 'messages': [{'role': 'user', 'content': 'Draft a caption.'}], 'seed': 17, 'reasoning_effort': 'high'})
    assert body['model'] == 'Qwen3.8-27B-Quark-AWQ-MXFP4'
    assert body['temperature'] == 0 and body['seed'] == 17
    assert body['chat_template_kwargs'] == {'enable_thinking': False}
    assert 'reasoning_effort' not in body and 'thinking_token_budget' not in body
    assert p['context'] == 8192 and p['max_tokens'] == 2048
    assert compatibility(p, device())['compatible']
    assert not compatibility(p, {**device(), 'total': 16 * 1024**3})['compatible']
    assert not compatibility(p, {**device(), 'name': 'AMD Radeon RX 9070 XT'})['compatible']
    with pytest.raises(ValueError): profile('qwen38-mxfp4-chat', 'image')


def test_volume_probe_is_offline_read_only_and_requires_both_snapshots(tmp_path):
    runtime = Runtime(Store(tmp_path), {'qwen38_mxfp4_cache_volume': 'existing-mxfp4-cache'})
    commands = []
    def command(args, **kwargs):
        commands.append(args)
        return CompletedProcess(args, 0, '', '')
    runtime.command = command
    release.preflight(runtime, release.IMAGE, inspected())
    probe = next(c for c in commands if c[0] == 'run')
    assert '--read-only' in probe and '--device' not in probe
    assert probe[probe.index('--network') + 1] == 'none'
    assert 'readonly,volume-nocopy' in probe[probe.index('--mount') + 1]
    checks = json.loads(probe[-1])
    assert len(checks) == 2
    assert all('/snapshots/' + spec['revision'] in item[0] for item, spec in zip(checks, release.MODELS.values()))
    release.preflight(runtime, release.IMAGE, inspected())
    assert sum(c[0] == 'run' for c in commands) == 1


def test_missing_volume_or_wrong_image_never_creates_or_downloads(tmp_path):
    runtime = Runtime(Store(tmp_path), {'qwen38_mxfp4_cache_volume': 'missing-cache'})
    calls = []
    runtime.command = lambda args, **kwargs: calls.append(args) or CompletedProcess(args, 1, '', '')
    with pytest.raises(ValueError, match='Qronos'):
        release.preflight(runtime, 'wrong', inspected('sha256:wrong'))
    assert not calls
    with pytest.raises(ValueError, match='will not create'):
        release.preflight(runtime, release.IMAGE, inspected())
    assert calls == [['volume', 'inspect', 'missing-cache']]
    for volume in ('/host/path', '../cache', 'cache:rw', '--help'):
        with pytest.raises(ValueError): release.sources({'qwen38_mxfp4_cache_volume': volume})


def test_partial_explicit_source_cannot_fall_back_to_another_checkpoint(tmp_path):
    with pytest.raises(ValueError, match='both'):
        release.sources({'qwen38_mxfp4_target_dir': str(tmp_path), 'qwen38_mxfp4_cache_volume': 'other-cache'})
    with pytest.raises(ValueError, match='missing or incomplete'):
        release.verify_folder(tmp_path, release.MODELS['draft'])
    data = b'{"test": 1}'
    (tmp_path / 'config.json').write_bytes(data)
    record = {'files': {'config.json': {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}}}
    release.verify_folder(tmp_path, record)
    (tmp_path / 'config.json').write_bytes(b'{"test": 2}')
    with pytest.raises(ValueError, match='does not match'): release.verify_folder(tmp_path, record)


def test_host_uid_launch_has_a_writable_home_and_user_identity(tmp_path):
    runtime = Runtime(Store(tmp_path), {'qwen38_mxfp4_cache_volume': 'verified-cache'})
    mounts, env = runtime.chat_source('qwen38-mxfp4', release.REVISION)
    assert mounts == [('verified-cache', '/pinned-cache')]
    assert env == {'USER': 'paiton', 'LOGNAME': 'paiton', 'HOME': '/models/cache'}


class Manager:
    def __init__(self, root, fail=False):
        self.root = root; self.fail = fail; self.downloads = []; self.commands = []; self.configured = None
    def run(self, args, job):
        self.commands.append(args)
        return SimpleNamespace(returncode=0, stdout=inspected())
    def update(self, *args, **kwargs): pass
    def download(self, url, path, size, digest, job):
        assert self.configured is None
        self.downloads.append((url, path, size, digest))
        if self.fail and 'DFlash2' in url: raise ValueError('Draft checksum failed')
    def configure(self, updates, job): self.configured = updates


def test_setup_downloads_exact_target_and_draft_before_registering(tmp_path):
    manager = Manager(tmp_path)
    release.install(manager, {'id': 'test'})
    assert len(manager.downloads) == 8
    assert sum(item[2] for item in manager.downloads) == release.DOWNLOAD_BYTES
    assert {part for spec in release.MODELS.values() for part in [spec['revision']]} == {url.split('/resolve/')[1].split('/')[0] for url, *_ in manager.downloads}
    assert all(Path(path).is_relative_to(tmp_path) and len(digest) == 64 for _, path, _, digest in manager.downloads)
    assert manager.configured['qwen38_mxfp4_image'] == release.IMAGE
    assert manager.configured['qwen38_mxfp4_target_dir'] != manager.configured['qwen38_mxfp4_draft_dir']
    assert all(command[1:3] == ['image', 'inspect'] for command in manager.commands)


def test_failed_draft_verification_does_not_register_half_a_package(tmp_path):
    manager = Manager(tmp_path, fail=True)
    with pytest.raises(ValueError, match='Draft checksum'):
        release.install(manager, {'id': 'test'})
    assert manager.configured is None


def test_new_model_reuses_runtime_between_writing_and_website_without_context_leak(qwen_runtime):
    state = qwen_runtime
    state.runtime.config.update(qwen38_mxfp4_image='pinned-qwen-image', qwen38_mxfp4_cache_volume='verified-cache')
    first = state.store.create_project('First')['id']; second = state.store.create_project('Second')['id']
    for project, suffix, extra in [(first, 'writing', {'prompt': 'PRIVATE-FIRST-BRIEF'}),
                                  (second, 'website', {'messages': [{'role': 'user', 'content': 'SECOND-PUBLIC-SITE'}]}),
                                  (first, 'writing', {'prompt': 'PRIVATE-FIRST-BRIEF'})]:
        request = dict(task='write', profile=profile('qwen38-mxfp4-' + suffix, 'write'), seed=12, **extra)
        job = state.store.enqueue(project, request)
        state.worker._run_job(job)
        assert state.store.job(job['id'])['state'] == 'completed'
    assert len(state.starts) == 1 and not state.stops
    assert state.starts[0][2][0] == '--offline'
    assert '--draft' in state.starts[0][2] and '--target' in state.starts[0][2]
    assert state.bodies[0][1] == state.bodies[2][1]
    assert 'PRIVATE-FIRST-BRIEF' not in json.dumps(state.bodies[1][1])
    assert state.bodies[1][1]['max_tokens'] == 3500
    state.runtime.touch_chat()
    state.clock[0] += 119
    assert not state.runtime.warm_expired()
