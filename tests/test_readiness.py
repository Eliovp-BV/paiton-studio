"""Qualification fixtures are policy tests, never hardware verification."""
from copy import deepcopy
import pytest
from studio.hardware_policy import evaluate
from studio.registry import package
from studio.readiness import report


def gpu(gib=32):
    return dict(driver_available=True, gpu_count=1, name='AMD Radeon AI PRO R9700',
                architecture='gfx1201', total=gib*1024**3, available=True, used=0, pids=[])


def policy():
    return deepcopy(package('flux')['hardware'])


@pytest.mark.parametrize('field,value', [
    ('required_vram_gib', float('nan')), ('minimum_reported_vram_gib', float('inf')),
    ('required_vram_gib', True), ('required_vram_gib', 10**1000), ('supported_architectures', 'gfx1201'),
    ('required_device_names', 'AMD Radeon AI PRO R9700'), ('schema_version', 2),
    ('schema_version', True), ('future_driver_requirement', '>=10'),
])
def test_unreadable_or_future_policy_never_admits(field, value):
    actual = evaluate({**policy(), field: value}, gpu())
    assert not actual['compatible'] and actual['status'] == 'unknown'
    assert actual['checks'][0]['id'] == 'qualification'


def test_all_blockers_reported_together_and_busy_is_not_incompatible():
    actual = evaluate(policy(), {**gpu(8), 'name': 'An unqualified board', 'architecture': 'gfx1100'})
    assert {c['id'] for c in actual['checks'] if c['status'] != 'compatible'} == {'architecture', 'capacity', 'device_qualification'}
    assert len(actual['reasons']) == 3
    assert evaluate(policy(), {**gpu(), 'available': False, 'used': 31*1024**3, 'pids': [987]})['compatible']


@pytest.mark.parametrize('value', [None, -1, float('nan'), float('inf'), True])
def test_unknown_or_invalid_capacity_is_not_eligible(value):
    assert not evaluate(policy(), {**gpu(), 'total': value})['compatible']


def test_boolean_device_count_is_not_one_gpu():
    assert not evaluate(policy(), {**gpu(), 'gpu_count': True})['compatible']


def host():
    return dict(platform=dict(system='Linux', machine='x86_64'), gpu=gpu(), sampled_at='fixture')


def tool():
    return dict(id='future-qualified', name='Test capability', model='Policy fixture only', integrated=True,
                installed=True, state='ready', compatibility=evaluate(policy(), gpu()),
                profiles=[dict(id='chat', label='Chat', roles=['chat'], state='ready', installed=True,
                               compatibility=evaluate(policy(), gpu())),
                          dict(id='write', label='Writing', roles=['write'], state='setup_required', installed=False,
                               compatibility=evaluate(policy(), gpu()))])


def test_roles_use_profile_readiness_not_package_best_state():
    actual = report(host(), [tool()])
    roles = {c['id']: c for c in actual['capabilities']}
    assert roles['chat']['state'] == 'ready'
    assert roles['write']['state'] == 'setup_required'
    assert roles['video']['state'] == 'unavailable'


def test_wrong_host_cannot_be_reported_ready():
    actual = report({**host(), 'platform': {'system': 'Windows', 'machine': 'AMD64'}}, [tool()])
    assert not actual['environment']['compatible']
    assert actual['models'][0]['state'] == 'environment_required'
    assert all(c['state'] == 'unavailable' for c in actual['capabilities'])


def test_runtime_rejects_unsupported_host_before_docker(tmp_path, monkeypatch):
    from studio.runtime import Runtime, RuntimeFailure
    from studio.store import Store
    monkeypatch.setattr('studio.readiness.platform.system', lambda: 'Windows')
    runtime = Runtime(Store(tmp_path), {})
    monkeypatch.setattr(runtime, 'command', lambda *a, **k: pytest.fail('No Docker on unsupported host'))
    with pytest.raises(RuntimeFailure, match='supported host'):
        runtime.preflight({})


def test_readiness_api_is_read_only_and_loads_no_models(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from studio.app import create_app
    from studio.runtime import Runtime
    monkeypatch.setattr('studio.app.gpu_status', gpu)
    monkeypatch.setattr('studio.app.SystemInfo.snapshot', lambda self: host())
    monkeypatch.setattr(Runtime, 'preflight', lambda *a: 'fixture-local-package')
    monkeypatch.setattr(Runtime, 'run', lambda *a: pytest.fail('Readiness must never generate'))
    app = create_app(tmp_path, config={}, worker_enabled=False)
    with TestClient(app) as client:
        client.get("/api/session")
        actual = client.get('/api/readiness')
        assert actual.status_code == 200
        body = actual.json()
        assert all(c['state'] == 'ready' for c in body['capabilities'])
        assert all(m['hardware']['checks'] for m in body['models'] if m['integrated'])
        assert client.get('/api/projects').json() == []
        assert app.state.store.rows('SELECT id FROM jobs') == []
        assert app.state.store.rows('SELECT id FROM setup_jobs') == []
