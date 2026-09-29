"""Runtime switching verifies immutable contracts without a daemon or GPU."""
import json
import subprocess
import threading

import pytest

from studio import runtime_packages
from studio.runtime_packages import REPOSITORY
from studio.setup import SetupManager, SetupCancelled
from studio.store import Store


FIRST = 'sha256:' + '1' * 64
SECOND = 'sha256:' + '2' * 64
OTHER = 'sha256:' + '3' * 64
MANIFEST = 'sha256:' + '4' * 64
FIRST_REF = REPOSITORY + ':image-v1'
SECOND_REF = REPOSITORY + ':image-v2'
LOCAL_REF = 'paiton-image:candidate'


def image(identity, tags=(), digests=()):
    return {'Id': identity, 'RepoTags': list(tags), 'RepoDigests': list(digests), 'Size': 1024,
            'Config': {'Labels': {'org.opencontainers.image.title': 'A deliberately untrusted model label'}}}


class FakeRuntime:
    def __init__(self):
        self.config = {'image_runtime': FIRST_REF, 'unrelated': 'preserve'}
        self.images = [image(FIRST, [FIRST_REF]), image(SECOND, [SECOND_REF, LOCAL_REF])]
        self.commands = []

    def command(self, arguments, **kwargs):
        self.commands.append(arguments)
        assert arguments[0] == 'image', 'Switching must never execute image code or touch containers.'
        if arguments[1] == 'ls':
            return subprocess.CompletedProcess(arguments, 0, '\n'.join(item['Id'] for item in self.images), '')
        assert arguments[:3] == ['image', 'inspect', '--']
        found = []
        for reference in arguments[3:]:
            found.extend(item for item in self.images if reference == item['Id'] or reference in item['RepoTags'] + item['RepoDigests'])
        return subprocess.CompletedProcess(arguments, 0 if found else 1, json.dumps(found), '')


@pytest.fixture
def setup(tmp_path):
    store = Store(tmp_path / 'data')
    result = SetupManager(store, FakeRuntime(), config_path=tmp_path / 'config.local.json')
    result._catalog = lambda: {'image-model': {
        'id': 'image-model', 'model': 'Image model', 'image_key': 'image_runtime',
        'installer': 'manual', 'required_disk_bytes': 500_000_000_000,
        'runtime_images': [
            {'reference': FIRST_REF, 'image_id': FIRST, 'label': 'Version 1'},
            {'reference': SECOND_REF, 'image_id': SECOND, 'label': 'Version 2'},
            {'reference': LOCAL_REF, 'image_id': SECOND, 'label': 'Candidate', 'channel': 'candidate'},
        ]}}
    result._system = lambda: {'ready': True, 'can_download': True, 'message': 'Ready',
                              'disk_free_bytes': 1, 'docker_disk_free_bytes': 20 * 1024**3}
    result.run = lambda *args, **kwargs: pytest.fail('Unexpected process launch')
    return result


def create_job(setup, package='image-model', state='queued'):
    project = setup.store.create_project()
    job = setup.store.enqueue(project['id'], {'profile': {'package': package}})
    if state != 'queued':
        setup.store.status(job['id'], state, 'Test request')
    return job


def test_snapshot_discovers_approved_images_and_deduplicates_tags(setup):
    setup.runtime.images.append(image(OTHER, [REPOSITORY + ':wrong-model']))
    snapshot = setup.runtime_packages.snapshot()
    package = snapshot['packages'][0]
    assert snapshot['available']
    assert package['current']['reference'] == FIRST_REF
    assert package['current']['image_id'] == FIRST
    assert package['current']['compatible']
    assert len(package['versions']) == 2
    assert {version['image_id'] for version in package['versions']} == {FIRST, SECOND}
    assert package['can_switch']
    assert all(call[0] == 'image' for call in setup.runtime.commands)


def test_switch_pins_id_persists_display_reference_and_merges_disk_config(setup):
    setup.config_path.write_text(json.dumps({'other_setting': 42}))
    selected = setup.runtime_packages.select('image-model', SECOND_REF)
    assert selected['current']['image_id'] == SECOND
    assert setup.runtime.config['image_runtime'] == SECOND
    saved = json.loads(setup.config_path.read_text())
    assert saved['image_runtime'] == SECOND
    assert saved['other_setting'] == 42 and saved['unrelated'] == 'preserve'
    assert saved['runtime_package_selections']['image_runtime']['reference'] == SECOND_REF
    # Moving the friendly tag later cannot change the connected image.
    setup.runtime.images[1]['RepoTags'].remove(SECOND_REF)
    setup.runtime.images[0]['RepoTags'].append(SECOND_REF)
    current = setup.runtime_packages.snapshot()['packages'][0]['current']
    assert current['reference'] == SECOND_REF and current['image_id'] == SECOND


def test_reviewed_local_candidate_selects_without_allowing_local_pull(setup):
    setup.runtime_packages.select('image-model', LOCAL_REF)
    assert setup.runtime.config['image_runtime'] == SECOND
    with pytest.raises(ValueError, match='full ghcr.io'):
        setup.runtime_packages.pull('image-model', LOCAL_REF)


@pytest.mark.parametrize('reference', [
    '--help', 'https://ghcr.io/eliovp/paiton-vllm-plugin:image-v2',
    'ghcr.io/rowamo/paiton-vllm-plugin:image-v2',
    'ghcr.io/eliovp/paiton-vllm-plugin.evil:image-v2',
    'ghcr.io/eliovp/paiton-vllm-plugin:bad tag',
    'localhost:5000/model:latest', REPOSITORY, None, {},
])
def test_untrusted_references_rejected_before_docker_or_network(setup, reference):
    with pytest.raises(ValueError):
        setup.runtime_packages.select('image-model', reference)
    with pytest.raises(ValueError):
        setup.runtime_packages.pull('image-model', reference)
    assert not setup.runtime.commands


def test_matching_name_or_oci_label_cannot_qualify_wrong_model(setup):
    setup.runtime.images[1] = image(OTHER, [SECOND_REF])
    with pytest.raises(ValueError, match='not an approved runtime'):
        setup.runtime_packages.select('image-model', SECOND_REF)
    assert setup.runtime.config['image_runtime'] == FIRST_REF
    assert not setup.config_path.exists()


def test_manifest_digest_qualifies_classic_docker_config_id(setup):
    spec = setup._catalog()['image-model']
    spec['runtime_images'] = [{'reference': REPOSITORY + '@' + MANIFEST}]
    setup._catalog = lambda: {'image-model': spec}
    setup.runtime.images[1]['RepoDigests'] = [REPOSITORY + '@' + MANIFEST]
    setup.runtime_packages.select('image-model', REPOSITORY + '@' + MANIFEST)
    assert setup.runtime.config['image_runtime'] == SECOND


@pytest.mark.parametrize('state', ['queued', 'preparing', 'loading', 'running', 'cancelling'])
def test_pending_or_active_creations_prevent_switching(setup, state):
    create_job(setup, state=state)
    assert not setup.runtime_packages.snapshot()['packages'][0]['can_switch']
    with pytest.raises(ValueError, match='queued and running'):
        setup.runtime_packages.select('image-model', SECOND_REF)
    assert setup.runtime.config['image_runtime'] == FIRST_REF


def test_shared_runtime_key_protects_related_model_jobs(setup):
    spec = setup._catalog()['image-model']
    setup._catalog = lambda: {'image-model': spec, 'other-preset': {**spec, 'id': 'other-preset'}}
    create_job(setup, package='other-preset')
    with pytest.raises(ValueError, match='queued and running'):
        setup.runtime_packages.select('image-model', SECOND_REF)


def test_other_models_and_completed_jobs_do_not_block_switch(setup):
    create_job(setup, package='unrelated-model')
    create_job(setup, state='completed')
    setup.runtime_packages.select('image-model', SECOND_REF)
    assert setup.runtime.config['image_runtime'] == SECOND


def test_setup_jobs_block_switch_and_duplicate_pulls_reuse_request(setup):
    first = setup.runtime_packages.pull('image-model', SECOND_REF)
    second = setup.runtime_packages.pull('image-model', SECOND_REF)
    assert first['id'] == second['id']
    with pytest.raises(ValueError, match='package setup'):
        setup.runtime_packages.select('image-model', SECOND_REF)


def test_explicit_pull_is_durable_and_connects_only_after_verification(setup):
    setup.runtime.images = setup.runtime.images[:1]
    job = setup.runtime_packages.pull('image-model', SECOND_REF)
    assert job['state'] == 'queued'
    assert setup.runtime.config['image_runtime'] == FIRST_REF
    calls = []
    def pull(arguments, job, **kwargs):
        calls.append(arguments)
        setup.runtime.images.append(image(SECOND, [SECOND_REF]))
    setup.run = pull
    setup.runtime_packages.run(job)
    assert calls == [['docker', 'pull', SECOND_REF]]
    assert setup.runtime.config['image_runtime'] == SECOND


def test_wrong_download_is_never_connected_or_executed(setup):
    reference = REPOSITORY + ':unrelated-tool'
    job = setup.runtime_packages.pull('image-model', reference)
    setup.run = lambda *args, **kwargs: setup.runtime.images.append(image(OTHER, [reference]))
    with pytest.raises(ValueError, match='not an approved runtime'):
        setup.runtime_packages.run(job)
    assert setup.runtime.config['image_runtime'] == FIRST_REF


def test_cancelled_download_cannot_update_configuration(setup):
    job = setup.runtime_packages.pull('image-model', SECOND_REF)
    setup.cancel(job['id'])
    with pytest.raises(SetupCancelled):
        setup.runtime_packages.run(job)
    assert setup.runtime.config['image_runtime'] == FIRST_REF


def test_generation_queued_during_download_keeps_previous_selection(setup):
    job = setup.runtime_packages.pull('image-model', SECOND_REF)
    setup.run = lambda *args, **kwargs: create_job(setup)
    with pytest.raises(ValueError, match='queued and running'):
        setup.runtime_packages.run(job)
    assert setup.runtime.config['image_runtime'] == FIRST_REF


def test_failed_atomic_write_keeps_live_and_disk_configuration(setup, monkeypatch):
    setup.config_path.write_text(json.dumps(setup.runtime.config))
    before = setup.config_path.read_bytes()
    def fail(*args):
        raise OSError('No space')
    monkeypatch.setattr(runtime_packages, 'atomic', fail)
    with pytest.raises(OSError):
        setup.runtime_packages.select('image-model', SECOND_REF)
    assert setup.runtime.config['image_runtime'] == FIRST_REF
    assert setup.config_path.read_bytes() == before


def test_job_admission_cannot_race_config_switch(setup, monkeypatch):
    entered, release, admitted = threading.Event(), threading.Event(), threading.Event()
    original = runtime_packages.atomic
    errors = []
    project = setup.store.create_project()
    def slow_write(*args):
        entered.set()
        assert release.wait(3)
        return original(*args)
    monkeypatch.setattr(runtime_packages, 'atomic', slow_write)
    def switch():
        try:
            setup.runtime_packages.select('image-model', SECOND_REF)
        except BaseException as error:
            errors.append(error)
    def enqueue():
        try:
            setup.store.enqueue(project['id'], {'profile': {'package': 'image-model'}})
            admitted.set()
        except BaseException as error:
            errors.append(error)
    switching = threading.Thread(target=switch)
    switching.start()
    assert entered.wait(2)
    submitting = threading.Thread(target=enqueue)
    submitting.start()
    try:
        assert not admitted.wait(.1)
    finally:
        release.set()
        switching.join(3)
        submitting.join(3)
    assert not errors and admitted.is_set()
    assert setup.runtime.config['image_runtime'] == SECOND


def test_setup_worker_dispatches_runtime_only_download_without_checkpoint_space(setup):
    job = setup.runtime_packages.pull('image-model', SECOND_REF)
    setup._needs_recovery = False
    calls = []
    setup.run = lambda arguments, *args, **kwargs: calls.append(arguments)
    original = setup.update
    def update(job, state, *args, **kwargs):
        original(job, state, *args, **kwargs)
        if state in {'completed', 'failed'}:
            setup.closed.set()
    setup.update = update
    worker = threading.Thread(target=setup._loop, daemon=True)
    worker.start()
    worker.join(3)
    setup.closed.set()
    assert not worker.is_alive()
    assert setup.job(job['id'])['state'] == 'completed'
    assert calls == [['docker', 'pull', SECOND_REF]]
    assert setup.runtime.config['image_runtime'] == SECOND


def test_h3_artifact_is_not_offered_as_a_working_runtime(setup):
    setup._catalog = lambda: {'h3': {'id': 'h3', 'image_key': 'h3_image', 'image': REPOSITORY + '@' + MANIFEST}}
    assert setup.runtime_packages.snapshot()['packages'][0]['versions'] == []
    with pytest.raises(ValueError, match='build input'):
        setup.runtime_packages.select('h3', REPOSITORY + '@' + MANIFEST)


def test_missing_docker_keeps_settings_available_with_clear_status(setup):
    setup.runtime.command = lambda *args, **kwargs: subprocess.CompletedProcess([], 127, '', 'Docker unavailable')
    snapshot = setup.runtime_packages.snapshot()
    assert not snapshot['available']
    assert 'Docker' in snapshot['message']
    assert not snapshot['packages'][0]['can_switch']
    assert not any(version['installed'] for version in snapshot['packages'][0]['versions'])


def test_runtime_download_request_survives_manager_restart(setup):
    job = setup.runtime_packages.pull('image-model', SECOND_REF)
    restarted = SetupManager(setup.store, setup.runtime, config_path=setup.config_path)
    assert restarted.runtime_packages.handles(job)
    assert restarted.job(job['id'])['state'] == 'queued'


def test_invalid_configuration_does_not_get_replaced_during_switch(setup):
    setup.config_path.write_text('{invalid')
    with pytest.raises(ValueError, match='configuration could not be read'):
        setup.runtime_packages.select('image-model', SECOND_REF)
    assert setup.config_path.read_text() == '{invalid'
    assert setup.runtime.config['image_runtime'] == FIRST_REF


def test_runtime_storage_space_is_checked_before_queuing_download(setup):
    setup._system = lambda: {'can_download': True, 'docker_disk_free_bytes': 1}
    with pytest.raises(ValueError, match='more free space'):
        setup.runtime_packages.pull('image-model', SECOND_REF)
    assert not setup.jobs()


def test_contract_pinned_package_lists_release_images_read_only(setup):
    from studio.conversation_options import IMAGES
    from studio.qwen_mxfp4 import IMAGE
    assert IMAGES == {'64k': IMAGE, '200k': IMAGE}
    setup._catalog = lambda: {'qwen38-mxfp4': {'id': 'qwen38-mxfp4', 'model': 'Qwen3.8 MXFP4', 'image_key': 'qwen38_mxfp4_image',
                                               'image': IMAGES['64k'], 'installer': 'qwen38-mxfp4'}}
    digest_64k, digest_200k = (value.split('@', 1)[1] for value in (IMAGES['64k'], IMAGES['200k']))
    setup.runtime.config['qwen38_mxfp4_image'] = FIRST
    setup.runtime.images = [image(FIRST, [], [IMAGES['64k']])]
    package = setup.runtime_packages.snapshot()['packages'][0]
    assert package['pinned'] and not package['can_switch'] and not package['can_pull']
    assert 'conversation memory' in package['message']
    assert [version['reference'] for version in package['versions']] == [IMAGE]
    assert [version['installed'] for version in package['versions']] == [True]
    assert '200K' in package['versions'][0]['label']
    assert package['current']['compatible'] and package['versions'][0]['selected']
    for action in ('select', 'pull'):
        with pytest.raises(ValueError, match='conversation memory'):
            getattr(setup.runtime_packages, action)('qwen38-mxfp4', IMAGES['200k'])
    assert setup.runtime.config['qwen38_mxfp4_image'] == FIRST
    assert digest_64k == digest_200k


def test_qwen_optional_payload_tracks_verification_default_and_setup_job(setup, tmp_path, monkeypatch):
    import hashlib
    from studio import qwen_mxfp4 as release
    spec = {**release.OPTIONAL_COMPONENTS['w3a4'], 'files': {
        'model.safetensors': {'bytes': 5, 'sha256': hashlib.sha256(b'valid').hexdigest()}}}
    monkeypatch.setattr(release, 'OPTIONAL_COMPONENTS', {'w3a4': spec})
    monkeypatch.setattr(release, '_VERIFIED', {})
    setup._catalog = lambda: {'qwen38-mxfp4': {
        'id': 'qwen38-mxfp4', 'model': 'Qwen3.8', 'image_key': 'qwen38_mxfp4_image',
        'image': release.IMAGE, 'installer': 'qwen38-mxfp4'}}
    setup.runtime.config['qwen38_mxfp4_image'] = release.IMAGE
    setup.runtime.images = [image(FIRST, [], [release.IMAGE])]

    def component():
        return setup.runtime_packages.snapshot()['packages'][0]['optional_components'][0]

    missing = component()
    assert missing['state'] == 'not_installed' and not missing['verified']
    assert not missing['enabled_default'] and missing['job'] is None
    assert missing['download_bytes'] == 9_550_285_694
    assert spec['revision'] in missing['license_url']
    assert missing['quality_note'] == release.W3_NOTE
    directory = tmp_path / 'w3'; directory.mkdir()
    tensor = directory / 'model.safetensors'; tensor.write_bytes(b'valid')
    setup.runtime.config['qwen38_w3rot_dir'] = str(directory)
    assert component()['state'] == 'verification_required'
    release.verify_folder(directory, spec)
    ready = component()
    assert ready['state'] == 'ready' and ready['installed'] and ready['verified']
    assert ready['enabled_default']
    setup.runtime.config[release.W3_DEFAULT_KEY] = False
    assert not component()['enabled_default']
    tensor.write_bytes(b'truncated')
    assert component()['state'] == 'repair_required'
    with setup.store.connect() as db:
        db.execute('INSERT INTO setup_jobs(id,package,component,state,message,created,updated) VALUES(?,?,?,?,?,?,?)',
                   ('optional-repair', 'qwen38-mxfp4', 'w3a4', 'queued', 'Queued', 1, 1))
    queued = component()
    assert queued['state'] == 'installing'
    assert queued['job']['id'] == 'optional-repair' and queued['job']['component'] == 'w3a4'
    setup.update('optional-repair', 'failed', 'Synthetic download error')
    failed = component()
    assert failed['state'] == 'repair_required' and failed['job']['state'] == 'failed'
    assert all(args[0] == 'image' for args in setup.runtime.commands)
