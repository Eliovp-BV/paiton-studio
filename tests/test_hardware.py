"""Synthetic hardware fixtures test routing policy; they are not GPU qualification."""
import pytest

from studio.registry import compatibility, profile, validate_snapshot
from studio.runtime import Runtime, RuntimeFailure
from studio.store import Store
from studio.telemetry import gpu_status


def device(gib=32, name='AMD Radeon AI PRO R9700', architecture='gfx1201'):
    return dict(driver_available=True, supported=True, gpu_count=1, total=gib*1024**3,
                name=name, architecture=architecture, available=True, used=0, pids=[])


def test_capacity_and_device_qualification_are_independent():
    sixteen = device(16, 'AMD Radeon RX 9070')
    for package in ('h3', 'qwen-coder', 'qwen38'):
        checked = compatibility(package, sixteen)
        assert not checked['compatible']
        assert 'capacity' in checked['reason']
        assert checked['required_vram_gib'] > 16
    image = compatibility('flux', sixteen)
    assert not image['compatible']
    assert image['required_vram_gib'] == 16
    assert 'R9700' in image['reason']  # Actual package code rejects this name.
    assert 'Enough memory alone' in image['reason']


def test_future_reviewed_smaller_model_is_eligible_on16gb_without_global_gate():
    future = {'id': 'fixture-small-image', 'integrated': True,
              'hardware': {'supported_architectures': ['gfx1201'], 'required_vram_gib': 12,
                           'minimum_reported_vram_gib': 11.5, 'required_device_names': [],
                           'qualification': 'Synthetic fixture, not a real model.'}}
    assert compatibility(future, device(16, 'AMD Radeon RX 9070'))['compatible']
    assert not compatibility(future, device(8, 'AMD Radeon RX 9070'))['compatible']
    assert not compatibility(future, device(16, 'Different card', 'gfx1100'))['compatible']
    assert not compatibility({'id': 'unreviewed', 'integrated': True}, device())['compatible']


def test_static_capacity_does_not_treat_busy_gpu_as_incompatible():
    busy = {**device(31.859375), 'available': False, 'pids': [123], 'used': 30*1024**3}
    for package in ('flux', 'h3', 'qwen-coder', 'qwen38'):
        assert compatibility(package, busy)['compatible']
    checked = compatibility('h3', busy)
    assert checked['required_vram_gib'] == 32
    assert checked['minimum_reported_vram_gib'] == 31


def test_unknown_architecture_identity_or_multi_gpu_fails_closed():
    assert not compatibility('qwen38', device(32, architecture='gfx1100'))['compatible']
    assert not compatibility('flux', {**device(), 'name': None})['compatible']
    assert not compatibility('flux', {**device(), 'driver_available': False})['compatible']
    assert not compatibility('flux', {**device(), 'gpu_count': 2})['compatible']


def test_gpu_detector_reports16gb_instead_of_blanket_unsupported(tmp_path):
    proc = tmp_path/'class/kfd/kfd/proc'; proc.mkdir(parents=True)
    card = tmp_path/'class/drm/card1/device'; card.mkdir(parents=True)
    (card/'mem_info_vram_total').write_text(str(16*1024**3))
    (card/'mem_info_vram_used').write_text('0')
    (card/'vendor').write_text('0x1002')
    (card/'product_name').write_text('AMD Radeon RX 9070')
    topology = tmp_path/'class/kfd/kfd/topology/nodes/1'; topology.mkdir(parents=True)
    (topology/'properties').write_text('gfx_target_version 120001\n')
    intel = tmp_path/'class/drm/card0/device'; intel.mkdir(parents=True)
    (intel/'mem_info_vram_total').write_text(str(8*1024**3))
    (intel/'mem_info_vram_used').write_text('0')
    (intel/'vendor').write_text('0x8086')
    actual = gpu_status(tmp_path)
    assert actual['supported'] and actual['available'] and actual['driver_available']
    assert actual['architecture'] == 'gfx1201' and actual['name'] == 'AMD Radeon RX 9070'
    assert actual['total'] == 16*1024**3 and actual['gpu_count'] == 1
    assert actual['utilization_percent'] is None


def test_gpu_target_is_parsed_for_future_architectures(tmp_path):
    (tmp_path/'class/kfd/kfd/proc').mkdir(parents=True)
    card = tmp_path/'class/drm/card1/device'; card.mkdir(parents=True)
    (card/'mem_info_vram_total').write_text(str(24*1024**3))
    (card/'mem_info_vram_used').write_text('0')
    topology = tmp_path/'class/kfd/kfd/topology/nodes/1'; topology.mkdir(parents=True)
    (topology/'properties').write_text('gfx_target_version 110003\n')
    actual = gpu_status(tmp_path)
    assert actual['architecture'] == 'gfx1103' and actual['supported']
    assert not compatibility('flux', actual)['compatible']


def test_retry_rechecks_actual_hardware_before_any_container_dispatch(tmp_path, monkeypatch):
    store = Store(tmp_path); project = store.create_project()
    request = {'task': 'image', 'profile': profile('image-standard', 'image'), 'prompt': 'A forest', 'seed': 771}
    request['profile'].pop('hardware')  # A project saved before hardware metadata existed.
    assert validate_snapshot(request['profile'], 'image')['hardware']['required_vram_gib'] == 16
    job = store.enqueue(project['id'], request)
    runtime = Runtime(store, {})
    monkeypatch.setattr('studio.runtime.gpu_status', lambda: device(16, 'AMD Radeon RX 9070'))
    runtime.command = lambda *args, **kwargs: pytest.fail('An incompatible profile must fail before starting a container')
    with pytest.raises(RuntimeFailure, match='R9700'):
        runtime.run(job)


def test_api_disables_each_incompatible_profile_and_rejects_submission(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from studio.app import create_app
    monkeypatch.setattr('studio.app.gpu_status', lambda: device(16, 'AMD Radeon RX 9070'))
    monkeypatch.setattr('studio.preferences.gpu_status', lambda: device(16, 'AMD Radeon RX 9070'))
    monkeypatch.setattr(Runtime, 'preflight', lambda self, request: 'fixture-installed')
    app = create_app(tmp_path, config={}, worker_enabled=False)
    with TestClient(app) as client:
        client.headers['X-Studio-Token'] = client.get('/api/session').json()['token']
        tools = client.get('/api/tools').json()
        for model in tools:
            if model['integrated']:
                assert model['state'] == 'incompatible'
                assert model['installed']
                assert all(p['state'] == 'incompatible' for p in model['profiles'])
                assert model['compatibility']['detected_vram_gib'] == 16
        project = client.post('/api/projects', json={}).json()['id']
        response = client.post(f'/api/projects/{project}/jobs', json={'task':'video','profile_id':'video-short','prompt':'A gentle pan'})
        assert response.status_code == 400 and 'capacity' in response.json()['error']
        assert client.get('/api/status').json()['jobs'] == []


def _telemetry_device(root, number, total, used=0):
    (root/'class/kfd/kfd/proc').mkdir(parents=True, exist_ok=True)
    card = root/f'class/drm/card{number}/device'
    card.mkdir(parents=True)
    (card/'mem_info_vram_total').write_text(str(total))
    (card/'mem_info_vram_used').write_text(str(used))
    topology = root/f'class/kfd/kfd/topology/nodes/{number}'
    topology.mkdir(parents=True)
    (topology/'properties').write_text('gfx_target_version 120001\n')
    return card


@pytest.mark.parametrize('total,used', [(32*1024**3,-1), (0,0), (16*1024**3,32*1024**3)])
def test_invalid_driver_memory_readings_never_admit(tmp_path, total, used):
    _telemetry_device(tmp_path, 1, total, used)
    actual = gpu_status(tmp_path)
    assert not actual['available']
    assert actual['driver_available']


def test_multiple_gpus_do_not_advertise_pooled_vram(tmp_path):
    _telemetry_device(tmp_path, 1, 16*1024**3)
    _telemetry_device(tmp_path, 2, 16*1024**3)
    actual = gpu_status(tmp_path)
    assert actual['gpu_count'] == 2 and not actual['available']
    assert actual['total'] is None and actual['used'] is None
