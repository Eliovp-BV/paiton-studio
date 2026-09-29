"""Image adapter contracts and lifecycle checks without GPU access."""
import hashlib
import io
import json
import os
from pathlib import Path
from subprocess import CompletedProcess
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from studio import qwen_image21 as adapter
from studio.app import create_app
from studio.preferences import SettingsInput, resolve_profile, save_settings
from studio.registry import compatible_profiles, profile, validate_snapshot, compatibility
from studio.runtime import Runtime, RuntimeFailure, Cancelled
from studio.store import Store, atomic


def request(identity='qwen-image21-1024'):
    return dict(task='image', profile=profile(identity, 'image'), prompt='A blue teapot', seed=0)


def test_supported_profiles_keep_exact_quality_and_device_contract():
    for identity in ('1024', '2048', 'rgba-1024', 'rgba-2048'):
        value = request('qwen-image21-' + identity)
        assert validate_snapshot(value['profile']) == value['profile']
        body = adapter.validate_request(value)
        assert body['model'] == 'paiton-image-2.1' and body['seed'] == 0
        assert body['steps'] == 40 and body['guidance'] == 1.0 and body['n'] == 1
        assert body['mode'] == ('rgba' if identity.startswith('rgba') else 'text-to-image')
    assert not compatibility('qwen-image21', dict(name='AMD Radeon RX 9070 XT', architecture='gfx1201', total=16*1024**3))['compatible']


def test_automatic_images_prefer_full_quality_without_changing_explicit_or_saved_profiles(tmp_path, monkeypatch):
    store = Store(tmp_path)
    monkeypatch.setattr('studio.preferences.gpu_status', lambda: dict(
        name='AMD Radeon AI PRO R9700', architecture='gfx1201', driver_available=True,
        gpu_count=1, total=32 * 1024**3))
    checked = []
    runtime = SimpleNamespace(preflight=lambda request: checked.append(request['profile']['id']))
    selected = resolve_profile(store, runtime, 'image')
    assert selected['id'] == 'qwen-image21-2048'
    assert selected['width'] == selected['height'] == 2048
    assert selected['steps'] == 40 and selected['guidance'] == 1.0
    assert checked == ['qwen-image21-2048']
    assert resolve_profile(store, runtime, 'image', 'qwen-image21-1024')['width'] == 1024
    save_settings(store, SettingsInput(defaults={'image': 'qwen-image21-1024'}))
    assert resolve_profile(store, runtime, 'image')['id'] == 'qwen-image21-1024'

    saved = {**profile('qwen-image21-1024', 'image'), 'label': 'Square · 1024 × 1024'}
    restored = validate_snapshot(saved, 'image')
    assert restored['id'] == 'qwen-image21-1024'
    assert (restored['width'], restored['height'], restored['steps'], restored['guidance']) == (1024, 1024, 40, 1.0)


@pytest.mark.parametrize('patch', [dict(prompt='x'*513), dict(prompt=' '), dict(seed=True), dict(seed=-1), dict(source={'id':'input'})])
def test_invalid_input_rejected_before_launch(patch):
    with pytest.raises(ValueError): adapter.validate_request({**request(), **patch})


@pytest.mark.parametrize('patch', [dict(width=512, height=512), dict(width=2048, height=1024),
    dict(width=1024.0), dict(steps=20), dict(steps=40.0), dict(guidance=True),
    dict(guidance=4.0), dict(batch=True), dict(batch=2), dict(mode='edit')])
def test_unqualified_profile_settings_are_rejected_before_launch(patch):
    value = request()
    value['profile'] = {**value['profile'], **patch}
    with pytest.raises(ValueError):
        adapter.validate_request(value)


def test_submission_rejects_overlong_qwen_prompt_without_enqueuing(tmp_path):
    app = create_app(tmp_path, config={}, worker_enabled=False)
    with TestClient(app) as client:
        client.headers['X-Studio-Token'] = client.get('/api/session').json()['token']
        project = client.post('/api/projects', json={}).json()['id']
        response = client.post(f'/api/projects/{project}/jobs', json=dict(task='image', profile_id='qwen-image21-1024', prompt='x'*513))
        assert response.status_code == 400 and '512' in response.text
        assert not app.state.store.rows('SELECT * FROM jobs')
        response = client.post(f'/api/projects/{project}/jobs', json=dict(task='image', profile_id='qwen-image21-rgba-2048', prompt='x'*512, seed=0))
        assert response.status_code == 200 and response.json()['request']['seed'] == 0


def test_submission_records_selected_style_beside_the_styled_prompt(tmp_path):
    app = create_app(tmp_path, config={}, worker_enabled=False)
    with TestClient(app) as client:
        client.headers['X-Studio-Token'] = client.get('/api/session').json()['token']
        project = client.post('/api/projects', json={}).json()['id']
        body = dict(task='image', profile_id='qwen-image21-1024', prompt='A blue teapot, cinematic style', seed=3, style='cinematic')
        stored = client.post(f'/api/projects/{project}/jobs', json=body).json()['request']
        assert stored['style'] == 'cinematic' and stored['prompt'] == 'A blue teapot, cinematic style' and stored['seed'] == 3
        # The runtime contract is unchanged: only the prompt reaches the image server.
        assert 'style' not in adapter.validate_request(stored)
        assert client.post(f'/api/projects/{project}/jobs', json={**body, 'style': 'neon'}).status_code == 422
        plain = client.post(f'/api/projects/{project}/jobs', json=dict(task='image', profile_id='qwen-image21-1024', prompt='A blue teapot', seed=3)).json()['request']
        assert 'style' not in plain and plain['prompt'] == 'A blue teapot'


def test_square_profiles_are_labelled_as_draft_preview_and_full_quality():
    for package in ('qwen-image21', 'qwen-image21-uncensored'):
        draft, full = profile(package + '-1024', 'image'), profile(package + '-2048', 'image')
        assert 'Draft / Preview · 1024 × 1024' in draft['label'] and draft['width'] == 1024
        assert '2048 × 2048' in full['label'] and 'Draft' not in full['label'] and full['width'] == 2048
        assert (draft['steps'], draft['guidance'], draft['batch']) == (full['steps'], full['guidance'], full['batch']) == (40, 1.0, 1)
    assert profile('qwen-image21-2048', 'image')['label'] == 'High quality · 2048 × 2048'


def test_image_validation_requires_immutable_approved_package():
    release = next(item for item in adapter.RUNTIME_IMAGES if item.get('channel') == 'candidate')
    assert adapter.validate_image([{'Id': release['image_id']}]) == release['image_id']
    with pytest.raises(ValueError, match='reviewed'):
        adapter.validate_image([{'Id':'sha256:'+'f'*64, 'RepoTags':[release['reference']]}])
    digest = adapter.IMAGE.split('@')[1]
    assert adapter.validate_image([{'Id':digest}]) == digest
    assert adapter.validate_image([{'Id':'sha256:'+'1'*64,'RepoDigests':[adapter.IMAGE]}]) == 'sha256:'+'1'*64


def test_latest_package_is_distinguished_from_legacy_quality_contracts():
    assert adapter.IMAGE == ('ghcr.io/eliovp/paiton-vllm-plugin@sha256:'
                            '64f6a6154b93f39b34f272fc66110ce17f72cca3ec31284ab57056ca5cdc2677')
    for release in adapter.RUNTIME_IMAGES:
        identity = release.get('image_id') or release['reference'].split('@', 1)[1]
        inspected = {'Id': identity}
        data, contract = adapter.image_contract(json.dumps([inspected]))
        assert data == inspected and contract == release
        assert (contract.get('precision_profile') == 'exact') == (release['reference'] in {
            adapter.IMAGE, 'ghcr.io/eliovp/paiton-vllm-plugin@sha256:'
            'c7ab0c5f900bf16c2b56fa5aa0f9dd7b8c32a0ea6106db954b43556c4cc07d97'})
        assert bool(contract.get('model_selection')) == (release['reference'] == adapter.IMAGE)


def receipt(selected):
    contract = adapter.model_contract(selected)
    return dict(precision_profile='exact', model=contract['api_id'], model_variant=contract['variant'],
                checkpoint_sha256=contract['checkpoint_sha256'],
                settings=dict(width=selected['width'], height=selected['height'],
                              output_resolution=selected['width'], num_inference_steps=40,
                              true_cfg_scale=1.0, use_kv_cache=True))


_DEFAULT_RECEIPT = object()


class FakeRuntime:
    def __init__(self, root):
        self.store = Store(root)
        self.calls = []
        self.cancel = False
        self.size = (1024, 1024)
        self.mode = 'RGBA'
        self.image_id = adapter.IMAGE.split('@', 1)[1]
        self.receipt = _DEFAULT_RECEIPT
        self.selected_model = 'paiton-image-2.1'
        self.model_variant = 'original'
    def config_path(self, key): return '/synthetic-checkpoint'
    def check_cancel(self, job):
        if self.cancel: raise Cancelled()
    def start(self, job, image, args, **kwargs):
        self.calls.append(('create', image, args, kwargs))
        return 'owned-test-container', self.store.root / 'jobs' / job['id']
    def command(self, args, **kwargs):
        self.calls.append(tuple(args))
        if args[:2] == ['image', 'inspect']:
            return CompletedProcess(args, 0, json.dumps([{'Id': self.image_id}]), '')
        return CompletedProcess(args, 0, '', '')
    def wait_ready(self, *args):
        self.calls.append(('ready',))
        selected = args[0]['request']['profile']
        return dict(model=self.selected_model, model_variant=self.model_variant,
                    checkpoint_sha256=adapter.model_contract(selected)['checkpoint_sha256'])
    def http(self, *args):
        return dict(data=[dict(id=self.selected_model,
            generation_sizes=['1024x1024','2048x2048'], rgba_sizes=['1024x1024','2048x2048'],
            edit_sizes=['1024x1024'], steps=40, guidance=1.0, batch_size=1)])
    def stream(self, job, args, **kwargs):
        self.calls.append(tuple(args))
        self.check_cancel(job)
        path = self.store.root / 'jobs' / job['id'] / 'result.png'
        Image.new(self.mode, self.size).save(path)
        if self.receipt is not None:
            metadata = receipt(job['request']['profile']) if self.receipt is _DEFAULT_RECEIPT else self.receipt
            atomic(path.with_name('result-metadata.json'), json.dumps(metadata).encode())
    def stop(self, container): self.calls.append(('stop', container))


def setup_job(tmp_path, identity='qwen-image21-1024'):
    runtime = FakeRuntime(tmp_path)
    job = runtime.store.enqueue(runtime.store.create_project()['id'], request(identity))
    directory = tmp_path / 'jobs' / job['id']
    directory.mkdir(parents=True)
    atomic(directory / 'request.json', json.dumps(job['request']).encode())
    return runtime, job, directory


def test_run_uses_offline_owned_api_and_preserves_alpha(tmp_path):
    runtime, job, directory = setup_job(tmp_path, 'qwen-image21-rgba-1024')
    kind, path, metadata = adapter.run(runtime, job, 'pinned-image', directory)
    assert kind == 'image' and path.name == 'result.png' and metadata['has_alpha']
    launch = next(call for call in runtime.calls if call[0] == 'create')
    assert '--offline' in launch[2] and '127.0.0.1' in launch[2]
    assert launch[2][-2:] == ['--precision-profile', 'exact']
    assert launch[2].index('--precision-profile') > launch[2].index('serve')
    assert launch[3]['mounts'] == [('/synthetic-checkpoint', '/checkpoint')]
    assert ('exec', 'owned-test-container', 'python3', '/studio/qwen_image21_job.py') in runtime.calls
    assert runtime.calls[-1] == ('stop', 'owned-test-container')


def test_full_size_transparent_output_is_preserved(tmp_path):
    runtime, job, directory = setup_job(tmp_path, 'qwen-image21-rgba-2048')
    runtime.size = (2048, 2048)
    kind, path, metadata = adapter.run(runtime, job, 'pinned-image', directory)
    assert kind == 'image' and metadata['has_alpha']
    assert metadata['width'] == metadata['height'] == 2048
    assert metadata['precision_profile'] == 'exact'
    assert metadata['checkpoint_sha256'] == receipt(job['request']['profile'])['checkpoint_sha256']
    assert metadata['settings']['num_inference_steps'] == 40
    with Image.open(path) as result:
        assert result.mode == 'RGBA' and result.size == (2048, 2048)


@pytest.mark.parametrize('channel', ['previous', 'candidate'])
def test_legacy_packages_keep_compatible_launcher_and_accept_original_receipts(tmp_path, channel):
    runtime, job, directory = setup_job(tmp_path)
    candidates = [item for item in adapter.RUNTIME_IMAGES if item['reference'] != adapter.IMAGE]
    release = next(item for item in candidates if not item.get('precision_profile')
                   and (item.get('channel') == 'candidate') == (channel == 'candidate'))
    runtime.image_id = release.get('image_id') or release['reference'].split('@', 1)[1]
    runtime.receipt = receipt(job['request']['profile'])
    runtime.receipt.pop('precision_profile')
    adapter.run(runtime, job, runtime.image_id, directory)
    launch = next(call for call in runtime.calls if call[0] == 'create')
    assert '--precision-profile' not in launch[2]
    assert runtime.calls[-1] == ('stop', 'owned-test-container')


@pytest.mark.parametrize('field,value', [
    ('width', 2048.0), ('height', 2048.0), ('output_resolution', 2048.0),
    ('num_inference_steps', 40.0), ('true_cfg_scale', True), ('use_kv_cache', 1),
])
def test_latest_receipt_rejects_types_that_compare_equal_to_quality_settings(tmp_path, field, value):
    runtime, job, directory = setup_job(tmp_path, 'qwen-image21-2048')
    runtime.size = (2048, 2048)
    runtime.receipt = receipt(job['request']['profile'])
    runtime.receipt['settings'][field] = value
    with pytest.raises(RuntimeFailure):
        adapter.run(runtime, job, 'pinned-image', directory)
    assert runtime.calls[-1] == ('stop', 'owned-test-container')


@pytest.mark.parametrize('failure', [
    'missing', 'wrong-precision', 'missing-precision', 'checkpoint', 'width', 'height',
    'output-resolution', 'steps', 'guidance', 'cache',
])
def test_latest_package_rejects_unverified_quality_receipts_and_cleans_up(tmp_path, failure):
    runtime, job, directory = setup_job(tmp_path, 'qwen-image21-2048')
    runtime.size = (2048, 2048)
    runtime.receipt = receipt(job['request']['profile'])
    if failure == 'missing': runtime.receipt = None
    elif failure == 'wrong-precision': runtime.receipt['precision_profile'] = 'schedule-int8'
    elif failure == 'missing-precision': runtime.receipt.pop('precision_profile')
    elif failure == 'checkpoint': runtime.receipt['checkpoint_sha256'] = 'f' * 64
    else:
        field, value = {
            'width': ('width', 1024), 'height': ('height', 1024),
            'output-resolution': ('output_resolution', 1024), 'steps': ('num_inference_steps', 20),
            'guidance': ('true_cfg_scale', 4.0), 'cache': ('use_kv_cache', False),
        }[failure]
        runtime.receipt['settings'][field] = value
    with pytest.raises(RuntimeFailure):
        adapter.run(runtime, job, 'pinned-image', directory)
    assert runtime.calls[-1] == ('stop', 'owned-test-container')


def test_unreviewed_package_is_rejected_before_container_creation(tmp_path):
    runtime, job, directory = setup_job(tmp_path)
    runtime.image_id = 'sha256:' + 'a' * 64
    with pytest.raises((RuntimeFailure, ValueError), match='reviewed'):
        adapter.run(runtime, job, 'unreviewed-image', directory)
    assert not any(call[0] in ('create', 'start', 'exec') for call in runtime.calls)


@pytest.mark.parametrize('failure', ['cancel', 'dimensions', 'alpha', 'model'])
def test_run_cleans_owned_container_on_invalid_result_and_cancellation(tmp_path, failure):
    runtime, job, directory = setup_job(tmp_path, 'qwen-image21-rgba-1024')
    if failure == 'cancel': runtime.cancel = True
    if failure == 'dimensions': runtime.size = (20, 20)
    if failure == 'alpha': runtime.mode = 'RGB'
    if failure == 'model': runtime.http = lambda *args: {'data':[]}
    with pytest.raises((RuntimeFailure, Cancelled)):
        adapter.run(runtime, job, 'pinned-image', directory)
    assert runtime.calls[-1] == ('stop', 'owned-test-container')


def test_queued_requests_and_retries_keep_original_image_identity(tmp_path):
    store = Store(tmp_path)
    runtime = Runtime(store, {'qwen_image21_image':'approved-tag'})
    first, second = 'sha256:'+'1'*64, 'sha256:'+'2'*64
    image_id = first
    runtime.command = lambda *args, **kwargs: CompletedProcess([], 0, json.dumps([{'Id':image_id}]), '')
    store.prepare_request = runtime.pin_request
    project = store.create_project()['id']
    initial = store.enqueue(project, request())
    image_id = second
    runtime.config['qwen_image21_image'] = 'another-approved-tag'
    retry = store.enqueue(project, initial['request'])
    latest = store.enqueue(project, request())
    assert retry['request']['runtime_image'] == initial['request']['runtime_image'] == first
    assert retry['request']['runtime_ref'] == 'approved-tag'
    assert latest['request']['runtime_image'] == second


def test_runtime_packages_api_requires_session_and_valid_reference(tmp_path):
    app = create_app(tmp_path, config={}, worker_enabled=False)
    with TestClient(app) as client:
        token = client.get('/api/session').json()['token']
        assert client.post('/api/runtime-packages/qwen-image21/select', json={'reference':'bad'}).status_code == 403
        client.headers['X-Studio-Token'] = token
        response = client.post('/api/runtime-packages/qwen-image21/select', json={'reference':'example.com/untrusted:tag'})
        assert response.status_code == 400
        assert client.post('/api/runtime-packages/qwen-image21/pull', json={'reference':'x','extra':'bad'}).status_code == 422


def test_checkpoint_setup_preserves_selected_candidate_and_verifies_downloads(tmp_path):
    release = next(item for item in adapter.RUNTIME_IMAGES if item.get('channel') == 'candidate')
    downloads, states = [], []
    config = {'qwen_image21_image': release['image_id']}
    manager = SimpleNamespace(root=tmp_path, config=config,
        runtime=SimpleNamespace(command=lambda *args: CompletedProcess([], 0, json.dumps([{'Id':release['image_id']}]), '')),
        update=lambda *args, **kwargs: states.append(args[1]),
        check_cancel=lambda job: None,
        run=lambda *args, **kwargs: pytest.fail('An installed candidate must not trigger a stable runtime pull'),
        download=lambda *args: downloads.append(args),
        configure=lambda values, job: config.update(values))
    adapter.install(manager, {'id':'fixture', 'package': 'qwen-image21'})
    assert config['qwen_image21_image'] == release['image_id']
    assert len(downloads) == len(adapter.CHECKPOINT['files'])
    assert all(adapter.REVISION in url and size > 0 and len(digest) == 64
               for url, path, size, digest, job in downloads)
    assert all(path.is_relative_to(tmp_path) for url, path, size, digest, job in downloads)


def test_runtime_recovers_container_identity_if_cancelled_during_start(tmp_path, monkeypatch):
    store = Store(tmp_path)
    runtime = Runtime(store, {})
    job = store.enqueue(store.create_project()['id'], request())
    runtime.preflight = lambda request: 'synthetic-runtime'
    stopped = []
    runtime.stop = stopped.append
    runtime.command = lambda *args, **kwargs: CompletedProcess([], 0,
        json.dumps([{'Id': adapter.IMAGE.split('@', 1)[1]}]), '')
    runtime.config_path = lambda key: '/checkpoint'
    def start(*args, **kwargs):
        store.status(job['id'], 'loading', 'Loading', container='just-created-owned-container')
        raise Cancelled()
    runtime.start = start
    monkeypatch.setattr('studio.runtime.gpu_status', lambda: dict(driver_available=True, supported=True,
        gpu_count=1, name='AMD Radeon AI PRO R9700', architecture='gfx1201', total=32*1024**3))
    with pytest.raises(Cancelled): runtime.run(job)
    assert stopped == ['just-created-owned-container']


def checkpoint_fixture(tmp_path, monkeypatch):
    """A tiny genuine HF layout; no model tensors or cache downloads."""
    repository = tmp_path / ('models--' + adapter.CHECKPOINT['repository'].replace('/', '--'))
    directory = repository / 'snapshots' / adapter.REVISION
    blobs = repository / 'blobs'
    blobs.mkdir(parents=True)
    files = []
    for name, content in [('LICENSE', b'Synthetic license fixture'), ('result.json', b'{"fixture":true}'),
                          ('transformer/config.json', b'{"fixture":"transformer"}'),
                          ('text_encoder/weights-00001.safetensors', b'Synthetic tensor fixture')]:
        digest = hashlib.sha256(content).hexdigest()
        blob = blobs / digest
        blob.write_bytes(content)
        path = directory / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.symlink_to(os.path.relpath(blob, path.parent))
        files.append(dict(file=name, bytes=len(content), sha256=digest))
    monkeypatch.setattr(adapter, 'CHECKPOINT', {**adapter.CHECKPOINT, 'files': files,
                                              'download_bytes': sum(item['bytes'] for item in files)})
    return directory, repository


def test_checkpoint_layout_preserves_materialized_directory_mounts(tmp_path):
    directory = tmp_path / 'materialized-checkpoint'
    directory.mkdir()
    assert adapter.checkpoint_layout(directory) == (directory, '/checkpoint', '/checkpoint')
    nonexistent = tmp_path / 'not-yet-installed'
    assert adapter.checkpoint_layout(nonexistent) == (nonexistent, '/checkpoint', '/checkpoint')


def test_existing_hf_checkpoint_is_verified_without_changing_or_materializing_files(tmp_path, monkeypatch):
    directory, repository = checkpoint_fixture(tmp_path, monkeypatch)
    before = {item['file']: (directory / item['file']).readlink() for item in adapter.CHECKPOINT['files']}
    runtime = SimpleNamespace(config_path=lambda key: str(directory))
    adapter.preflight(runtime, [{'Id': adapter.IMAGE.split('@', 1)[1]}])
    assert adapter.checkpoint_layout(directory) == (
        repository, '/checkpoint-cache', '/checkpoint-cache/snapshots/' + adapter.REVISION)
    assert {item['file']: (directory / item['file']).readlink() for item in adapter.CHECKPOINT['files']} == before
    assert all((directory / item['file']).is_symlink() for item in adapter.CHECKPOINT['files'])


@pytest.mark.parametrize('damage', ['outside', 'outside-through-blob', 'outside-blobs-in-repo',
    'absolute-link', 'blob-directory', 'redirected-parent', 'missing', 'revision', 'checksum'])
def test_hf_checkpoint_rejects_untrusted_or_incomplete_cache_files(tmp_path, monkeypatch, damage):
    directory, repository = checkpoint_fixture(tmp_path, monkeypatch)
    source = directory / 'result.json'
    blob = source.resolve()
    if damage in ('outside', 'outside-through-blob', 'outside-blobs-in-repo'):
        target = (repository if damage == 'outside-blobs-in-repo' else tmp_path) / 'untrusted-result.json'
        target.write_bytes(blob.read_bytes())
        if damage == 'outside-through-blob':
            blob.unlink()
            blob.symlink_to(target)
        else:
            source.unlink()
            source.symlink_to(os.path.relpath(target, source.parent))
    elif damage == 'absolute-link':
        source.unlink()
        source.symlink_to(blob)
    elif damage == 'blob-directory':
        outside = tmp_path / 'external-blobs'
        (repository / 'blobs').rename(outside)
        (repository / 'blobs').symlink_to(outside, target_is_directory=True)
    elif damage == 'redirected-parent':
        outside = repository / 'redirected-transformer'
        (directory / 'transformer').rename(outside)
        (directory / 'transformer').symlink_to(outside, target_is_directory=True)
    elif damage == 'missing':
        blob.unlink()
    elif damage == 'revision':
        wrong = directory.with_name('0' * 40)
        directory.rename(wrong)
        directory = wrong
    elif damage == 'checksum':
        blob.write_bytes(b'x' * blob.stat().st_size)
    runtime = SimpleNamespace(config_path=lambda key: str(directory))
    with pytest.raises(ValueError):
        adapter.preflight(runtime, [{'Id': adapter.IMAGE.split('@', 1)[1]}])


def test_hf_checkpoint_launch_mounts_its_repository_read_only_instead_of_broken_snapshot(tmp_path, monkeypatch):
    directory, repository = checkpoint_fixture(tmp_path / 'cache', monkeypatch)
    runtime, job, job_directory = setup_job(tmp_path / 'studio', 'qwen-image21-2048')
    runtime.size = (2048, 2048)
    runtime.config_path = lambda key: str(directory)
    # The launch receipt belongs to the published package; tiny fixture hashes
    # are used only for the host checkpoint layout and preflight above.
    runtime.receipt = receipt(job['request']['profile'])
    runtime.receipt['checkpoint_sha256'] = adapter.CHECKPOINT_SHA256
    adapter.run(runtime, job, 'pinned-image', job_directory)
    launch = next(call for call in runtime.calls if call[0] == 'create')
    assert launch[3]['mounts'] == [(str(repository), '/checkpoint-cache')]
    assert launch[2][launch[2].index('--model-dir') + 1] == '/checkpoint-cache/snapshots/' + adapter.REVISION
    assert '--offline' in launch[2]
    assert runtime.calls[-1] == ('stop', 'owned-test-container')


def image_asset(store, project, *, size=(640, 480), format='PNG', kind='image'):
    """Synthetic CPU image; fixtures never read a user's assets or model cache."""
    content = io.BytesIO()
    Image.new('RGB', size, (30, 90, 140)).save(content, format=format)
    return store.add_asset(project, kind, 'Source image', content.getvalue(),
                           '.png' if format == 'PNG' else '.jpg',
                           dict(width=size[0], height=size[1], format=format))


def edit_request(asset, identity='qwen-image21-edit'):
    return {**request(identity), 'source': dict(id=asset['id'], project=asset['project'],
            path=asset['path'], sha256=asset['metadata']['sha256'])}


def test_uncensored_profiles_have_distinct_pinned_identity_and_edit_role():
    original = profile('qwen-image21-2048', 'image', 'image')
    alternative = profile('qwen-image21-uncensored-2048', 'image', 'image')
    assert alternative['package'] == 'qwen-image21-uncensored'
    assert alternative['revision'] != original['revision']
    assert adapter.validate_request(request(alternative['id']))['model'] == 'paiton-image-2.1-uncensored'
    assert validate_snapshot(alternative, 'image')['id'] == alternative['id']
    with pytest.raises(ValueError):
        validate_snapshot({**alternative, 'revision': original['revision']}, 'image')
    editing = compatible_profiles('image_edit')
    assert {item['id'] for item in editing} == {'qwen-image21-edit', 'qwen-image21-uncensored-edit'}
    assert all(item['mode'] == 'edit' and item['width'] == item['height'] == 1024 for item in editing)
    assert not {item['id'] for item in editing} & {item['id'] for item in compatible_profiles('image')}
    with pytest.raises(ValueError):
        profile('qwen-image21-uncensored-edit', 'image', 'image')
    with pytest.raises(ValueError):
        profile('qwen-image21-2048', 'image', 'image_edit')


def test_automatic_selection_never_falls_back_to_uncensored_without_opt_in(tmp_path):
    store = Store(tmp_path)
    checked = []
    def preflight(value):
        checked.append(value['profile']['package'])
        if value['profile']['package'] != 'qwen-image21-uncensored':
            raise RuntimeFailure('Original model is unavailable')
    runtime = SimpleNamespace(preflight=preflight)
    for role in ('image', 'image_edit'):
        with pytest.raises(ValueError, match='No installed'):
            resolve_profile(store, runtime, role)
    assert 'qwen-image21-uncensored' not in checked
    assert resolve_profile(store, runtime, 'image', 'qwen-image21-uncensored-2048')['package'] == 'qwen-image21-uncensored'
    save_settings(store, SettingsInput(defaults={'image': 'qwen-image21-uncensored-2048',
                                               'image_edit': 'qwen-image21-uncensored-edit'}))
    assert resolve_profile(store, runtime, 'image')['id'] == 'qwen-image21-uncensored-2048'
    assert resolve_profile(store, runtime, 'image_edit')['id'] == 'qwen-image21-uncensored-edit'


@pytest.mark.parametrize('identity', ['qwen-image21-edit', 'qwen-image21-uncensored-edit'])
def test_edit_submission_snapshots_project_source_without_replacing_original(tmp_path, identity):
    app = create_app(tmp_path, config={}, worker_enabled=False)
    with TestClient(app) as client:
        client.headers['X-Studio-Token'] = client.get('/api/session').json()['token']
        project = client.post('/api/projects', json={}).json()['id']
        asset = image_asset(app.state.store, project, format='JPEG')
        original = app.state.store.file(asset).read_bytes()
        submitted = client.post(f'/api/projects/{project}/jobs', json=dict(
            task='image', profile_id=identity, prompt='Make the background blue', source_id=asset['id'], seed=0))
        assert submitted.status_code == 200, submitted.text
        saved = submitted.json()['request']
        assert saved['profile']['mode'] == 'edit' and saved['profile']['width'] == 1024
        assert saved['source']['id'] == asset['id'] and saved['source']['project'] == project
        assert saved['source']['sha256'] == hashlib.sha256(original).hexdigest()
        assert len(app.state.store.assets(project)) == 1
        assert app.state.store.file(asset).read_bytes() == original
        assert submitted.json()['state'] == 'queued'


@pytest.mark.parametrize('problem', ['missing', 'foreign-project', 'wrong-kind', 'oversized', 'corrupt', 'changed', 'create-profile'])
def test_edit_submission_rejects_invalid_source_before_enqueue(tmp_path, problem):
    app = create_app(tmp_path, config={}, worker_enabled=False)
    with TestClient(app) as client:
        client.headers['X-Studio-Token'] = client.get('/api/session').json()['token']
        store = app.state.store
        project = store.create_project()['id']
        asset_project = store.create_project()['id'] if problem == 'foreign-project' else project
        asset = image_asset(store, asset_project, size=(2049, 2048) if problem == 'oversized' else (64, 64),
                            kind='text' if problem == 'wrong-kind' else 'image')
        if problem == 'corrupt':
            asset = store.add_asset(project, 'image', 'Malformed image', b'not a complete image', '.png', {})
        if problem == 'changed':
            store.file(asset).write_bytes(store.file(image_asset(store, project)).read_bytes())
        body = dict(task='image', profile_id='qwen-image21-edit', prompt='Change the background', source_id=asset['id'])
        if problem == 'missing': body.pop('source_id')
        if problem == 'create-profile': body['profile_id'] = 'qwen-image21-2048'
        result = client.post(f'/api/projects/{project}/jobs', json=body)
        assert result.status_code == 400, result.text
        assert not store.rows('SELECT * FROM jobs')


@pytest.mark.parametrize('format', ['PNG', 'JPEG'])
def test_source_preparation_keeps_pixels_and_original_bytes_and_uses_png(tmp_path, format):
    store = Store(tmp_path)
    project = store.create_project()['id']
    asset = image_asset(store, project, size=(320, 180), format=format)
    original = store.file(asset).read_bytes()
    png, metadata = adapter.validate_source(store, edit_request(asset), project=project)
    assert png.startswith(b'\x89PNG\r\n\x1a\n')
    with Image.open(io.BytesIO(png)) as image:
        assert image.size == (320, 180) and image.mode == 'RGBA'
        with Image.open(io.BytesIO(original)) as source:
            assert image.convert('RGB').tobytes() == source.convert('RGB').tobytes()
    assert store.file(asset).read_bytes() == original
    assert len(store.assets(project)) == 1


@pytest.mark.parametrize('field,value', [('id', 'missing'), ('project', 'another-project'),
    ('path', '../outside.png'), ('sha256', '0' * 64)])
def test_saved_edit_source_identity_cannot_be_substituted(tmp_path, field, value):
    store = Store(tmp_path)
    project = store.create_project()['id']
    asset = image_asset(store, project)
    saved = edit_request(asset)
    saved['source'][field] = value
    with pytest.raises(ValueError):
        adapter.validate_source(store, saved, project=project)


def test_edit_accepts_exact_input_pixel_limit_and_rejects_large_output(tmp_path):
    store = Store(tmp_path)
    project = store.create_project()['id']
    saved = edit_request(image_asset(store, project, size=(2048, 2048)))
    adapter.validate_source(store, saved, project=project)
    body = adapter.validate_request(saved)
    assert body['mode'] == 'edit' and body['size'] == '1024x1024'
    saved['profile'] = {**saved['profile'], 'width': 2048, 'height': 2048}
    with pytest.raises(ValueError):
        adapter.validate_request(saved)


@pytest.mark.parametrize('identity', ['qwen-image21-edit', 'qwen-image21-uncensored-edit'])
def test_edit_run_prepares_owned_png_and_selects_matching_checkpoint(tmp_path, identity):
    runtime, job, directory = setup_job(tmp_path, identity)
    asset = image_asset(runtime.store, job['project'], format='JPEG')
    original = runtime.store.file(asset).read_bytes()
    job['request']['source'] = edit_request(asset, identity)['source']
    selected = adapter.model_contract(job['request']['profile'])
    runtime.selected_model, runtime.model_variant = selected['api_id'], selected['variant']
    requested_config = []
    runtime.config_path = lambda key: requested_config.append(key) or '/synthetic-checkpoint'
    kind, result, metadata = adapter.run(runtime, job, 'pinned-image', directory)
    assert kind == 'image' and result.name == 'result.png'
    assert metadata['model'] == selected['api_id'] and metadata['model_variant'] == selected['variant']
    assert metadata['width'] == metadata['height'] == 1024
    assert selected['model_dir_key'] in requested_config
    assert (directory / 'source.png').is_file()
    with Image.open(directory / 'source.png') as prepared:
        assert prepared.format == 'PNG' and prepared.size == (640, 480)
    assert runtime.store.file(asset).read_bytes() == original
    launch = next(call for call in runtime.calls if call[0] == 'create')
    assert launch[2][launch[2].index('--model') + 1] == selected['variant']
    assert launch[2].index('--model') < launch[2].index('serve')
    assert runtime.calls[-1] == ('stop', 'owned-test-container')


@pytest.mark.parametrize('failure', ['changed', 'foreign-project', 'missing'])
def test_edit_source_is_rechecked_before_container_creation(tmp_path, failure):
    runtime, job, directory = setup_job(tmp_path, 'qwen-image21-edit')
    project = runtime.store.create_project()['id'] if failure == 'foreign-project' else job['project']
    asset = image_asset(runtime.store, project)
    job['request']['source'] = edit_request(asset)['source']
    if failure == 'changed': runtime.store.file(asset).write_bytes(b'changed after queuing')
    if failure == 'missing': runtime.store.file(asset).unlink()
    with pytest.raises((ValueError, RuntimeFailure)):
        adapter.run(runtime, job, 'pinned-image', directory)
    assert not any(call[0] in ('create', 'start', 'exec') for call in runtime.calls)


@pytest.mark.parametrize('identity', ['qwen-image21-uncensored-2048', 'qwen-image21-edit'])
def test_legacy_runtime_cannot_launch_uncensored_or_edit_profiles(tmp_path, identity):
    runtime, job, directory = setup_job(tmp_path, identity)
    if identity.endswith('-edit'):
        job['request']['source'] = edit_request(image_asset(runtime.store, job['project']))['source']
    runtime.image_id = 'sha256:c7ab0c5f900bf16c2b56fa5aa0f9dd7b8c32a0ea6106db954b43556c4cc07d97'
    with pytest.raises((ValueError, RuntimeFailure)):
        adapter.run(runtime, job, runtime.image_id, directory)
    assert not any(call[0] in ('create', 'start', 'exec') for call in runtime.calls)


@pytest.mark.parametrize('field,value', [('model', 'paiton-image-2.1'), ('model_variant', 'original'),
    ('checkpoint_sha256', adapter.CHECKPOINT_SHA256), ('model', None), ('model_variant', None)])
def test_uncensored_receipt_rejects_wrong_or_missing_checkpoint_identity(tmp_path, field, value):
    runtime, job, directory = setup_job(tmp_path, 'qwen-image21-uncensored-1024')
    runtime.selected_model, runtime.model_variant = 'paiton-image-2.1-uncensored', 'uncensored'
    runtime.receipt = receipt(job['request']['profile'])
    if value is None: runtime.receipt.pop(field)
    else: runtime.receipt[field] = value
    with pytest.raises(RuntimeFailure):
        adapter.run(runtime, job, 'pinned-image', directory)
    assert runtime.calls[-1] == ('stop', 'owned-test-container')


@pytest.mark.parametrize('boundary', ['health-model', 'health-variant', 'health-checkpoint', 'models'])
def test_wrong_loaded_model_is_rejected_before_generation_and_cleaned_up(tmp_path, boundary):
    runtime, job, directory = setup_job(tmp_path, 'qwen-image21-uncensored-1024')
    runtime.selected_model, runtime.model_variant = 'paiton-image-2.1-uncensored', 'uncensored'
    if boundary == 'models':
        runtime.http = lambda *args: dict(data=[dict(id='paiton-image-2.1',
            generation_sizes=['1024x1024'], steps=40, guidance=1.0, batch_size=1)])
    else:
        health = dict(model=runtime.selected_model, model_variant=runtime.model_variant,
                      checkpoint_sha256=adapter.model_contract(job['request']['profile'])['checkpoint_sha256'])
        key = {'health-model': 'model', 'health-variant': 'model_variant', 'health-checkpoint': 'checkpoint_sha256'}[boundary]
        health[key] = 'incorrect-checkpoint'
        runtime.wait_ready = lambda *args: health
    with pytest.raises(RuntimeFailure):
        adapter.run(runtime, job, 'pinned-image', directory)
    assert not any(call[0] == 'exec' for call in runtime.calls)
    assert runtime.calls[-1] == ('stop', 'owned-test-container')


def test_uncensored_setup_uses_separate_verified_checkpoint_and_preserves_original(tmp_path):
    selected = adapter.model_contract(profile('qwen-image21-uncensored-2048', 'image'))
    downloads, states = [], []
    config = {'qwen_image21_image': 'keep-original-runtime', 'qwen_image21_model_dir': '/keep/original/checkpoint',
              selected['image_key']: adapter.IMAGE}
    manager = SimpleNamespace(root=tmp_path, config=config,
        runtime=SimpleNamespace(command=lambda *args: CompletedProcess([], 0,
            json.dumps([{'Id': adapter.IMAGE.split('@', 1)[1]}]), '')),
        update=lambda *args, **kwargs: states.append(args[1]), check_cancel=lambda job: None,
        run=lambda *args, **kwargs: pytest.fail('An installed runtime must not be pulled again'),
        download=lambda *args: downloads.append(args), configure=lambda values, job: config.update(values))
    adapter.install(manager, {'id': 'uncensored-fixture', 'package': 'qwen-image21-uncensored'})
    assert config['qwen_image21_image'] == 'keep-original-runtime'
    assert config['qwen_image21_model_dir'] == '/keep/original/checkpoint'
    assert config[selected['image_key']] == adapter.IMAGE
    assert selected['revision'] in config[selected['model_dir_key']]
    assert len(downloads) == len(selected['checkpoint']['files'])
    assert all(selected['checkpoint']['repository'] in url and selected['revision'] in url
               for url, path, size, digest, job in downloads)
    assert all(path.is_relative_to(tmp_path / 'model-packages' / 'qwen-image21-uncensored')
               and size > 0 and len(digest) == 64 for url, path, size, digest, job in downloads)


def test_wrong_variant_checkpoint_cache_is_rejected_before_reading_weights(tmp_path):
    original_revision = profile('qwen-image21-2048', 'image')['revision']
    directory = tmp_path / 'models--original' / 'snapshots' / original_revision
    directory.mkdir(parents=True)
    (directory.parent.parent / 'blobs').mkdir()
    selected = profile('qwen-image21-uncensored-2048', 'image')
    with pytest.raises(ValueError):
        adapter.checkpoint_layout(directory, selected)
    inspected = [{'Id': adapter.IMAGE.split('@', 1)[1]}]
    with pytest.raises(ValueError):
        adapter.preflight(SimpleNamespace(config_path=lambda key: str(directory)), inspected, selected)


def test_v102_original_quality_receipt_remains_valid_without_v103_identity_fields(tmp_path):
    runtime, job, directory = setup_job(tmp_path)
    runtime.image_id = 'sha256:c7ab0c5f900bf16c2b56fa5aa0f9dd7b8c32a0ea6106db954b43556c4cc07d97'
    runtime.receipt = receipt(job['request']['profile'])
    runtime.receipt.pop('model')
    runtime.receipt.pop('model_variant')
    runtime.wait_ready = lambda *args: None
    adapter.run(runtime, job, runtime.image_id, directory)
    launch = next(call for call in runtime.calls if call[0] == 'create')
    assert '--model' not in launch[2]
    assert launch[2][-2:] == ['--precision-profile', 'exact']
    assert runtime.calls[-1] == ('stop', 'owned-test-container')


def test_edit_source_orientation_is_applied_to_copy_and_provenance_is_retained(tmp_path):
    store = Store(tmp_path)
    project = store.create_project()['id']
    content = io.BytesIO()
    image = Image.new('RGB', (80, 40), (90, 100, 110))
    exif = Image.Exif()
    exif[274] = 6
    image.save(content, format='JPEG', exif=exif)
    asset = store.add_asset(project, 'image', 'Rotated camera image', content.getvalue(), '.jpg', {})
    png, metadata = adapter.validate_source(store, edit_request(asset), project=project)
    with Image.open(io.BytesIO(png)) as prepared:
        assert prepared.size == (40, 80)
    assert metadata['source_id'] == asset['id']
    assert metadata['source_sha256'] == hashlib.sha256(content.getvalue()).hexdigest()
    assert metadata['source_width'] == 40 and metadata['source_height'] == 80
    assert store.file(asset).read_bytes() == content.getvalue()


def test_source_file_byte_limit_is_checked_before_decoding(tmp_path, monkeypatch):
    store = Store(tmp_path)
    project = store.create_project()['id']
    asset = image_asset(store, project)
    monkeypatch.setattr(adapter, 'MAX_SOURCE_BYTES', store.file(asset).stat().st_size - 1)
    with pytest.raises(ValueError, match='32 MiB|size|exceed'):
        adapter.validate_source(store, edit_request(asset), project=project)


def test_generation_helper_is_not_invoked_when_runtime_does_not_offer_editing(tmp_path):
    runtime, job, directory = setup_job(tmp_path, 'qwen-image21-edit')
    asset = image_asset(runtime.store, job['project'])
    job['request']['source'] = edit_request(asset)['source']
    original_http = runtime.http
    def no_editing(*args):
        value = original_http(*args)
        value['data'][0].pop('edit_sizes')
        return value
    runtime.http = no_editing
    with pytest.raises(RuntimeFailure):
        adapter.run(runtime, job, 'pinned-image', directory)
    assert not any(call[0] == 'exec' for call in runtime.calls)
    assert runtime.calls[-1] == ('stop', 'owned-test-container')
