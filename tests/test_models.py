import json
from pathlib import Path
from subprocess import CompletedProcess

import pytest

from studio.chat_adapters import writing_body
from studio.registry import compatible_profiles, profile, validate_snapshot
from studio.runtime import Runtime, RuntimeFailure
from studio.store import Store
from studio.telemetry import gpu_status


def test_roles_only_expose_compatible_model_profiles():
    assert {p['package'] for p in compatible_profiles('video')} == {'h3','wan'}
    assert {p['package'] for p in compatible_profiles('image')} == {'flux'}
    assert {p['package'] for p in compatible_profiles('write')} == {'qwen38', 'qwen-coder','gptoss'}
    assert {p['package'] for p in compatible_profiles('website')} == {'qwen38', 'qwen-coder'}
    assert {p['id'] for p in compatible_profiles('write')}.isdisjoint(p['id'] for p in compatible_profiles('website'))
    with pytest.raises(ValueError): profile('qwen38-writing', 'video')
    with pytest.raises(ValueError): profile('qwen38-writing', 'write', 'website')
    with pytest.raises(ValueError): compatible_profiles('unknown')


def test_persisted_execution_snapshot_rejects_model_and_setting_substitution():
    p = profile('qwen38-writing', 'write')
    for changes in ({'package': 'h3'}, {'revision': 'latest'}, {'context': 32768}, {'max_tokens': 8192}, {'adapter': 'paiton-h3'}, {'unqualified_setting': True}):
        with pytest.raises(ValueError): validate_snapshot({**p, **changes}, 'write')
    with pytest.raises(ValueError): validate_snapshot(p, 'video')
    old = profile('writing-standard', 'write')
    for key in ('adapter', 'roles', 'capabilities'): old.pop(key)
    old['label'] = 'Old display label'
    assert validate_snapshot(old, 'write')['max_tokens'] == 1024
    p['roles'].append('video')
    assert 'video' not in profile('qwen38-writing', 'write')['roles']


def test_qwen_writing_and_structured_planner_use_pinned_token_limits():
    standard = writing_body({'profile': profile('qwen38-writing', 'write'), 'prompt': 'Write a caption'})
    assert standard['model'] == 'qwen38'
    assert standard['max_tokens'] == 2048
    assert standard['chat_template_kwargs'] == {'enable_thinking': False}
    messages = [{'role': 'system', 'content': 'Return a JSON website plan'}, {'role': 'user', 'content': 'A woodland studio'}]
    plan = writing_body({'profile': profile('qwen38-website', 'write'), 'messages': messages, 'seed': 771})
    assert plan['messages'] == messages
    assert plan['max_tokens'] == 3500
    assert plan['seed'] == 771
    assert 'seed' not in standard  # Old persisted jobs keep the runtime default.
    assert writing_body({'profile': profile('writing-standard', 'write'), 'prompt': 'Caption', 'seed': 0})['seed'] == 0
    assert 'response_format' not in plan
    with pytest.raises(ValueError): writing_body({'profile': profile('qwen38-writing', 'write'), 'messages': messages})
    with pytest.raises(ValueError): writing_body({'profile': profile('qwen38-website', 'write'), 'messages': [{'role': 'tool', 'content': 'unsupported'}]})


def fake_sysfs(tmp_path):
    proc = tmp_path/'class/kfd/kfd/proc'; proc.mkdir(parents=True)
    topology = tmp_path/'class/kfd/kfd/topology/nodes/1'; topology.mkdir(parents=True)
    (topology/'properties').write_text('gfx_target_version 120001\n')
    device = tmp_path/'class/drm/card1/device'; device.mkdir(parents=True)
    (device/'mem_info_vram_total').write_text(str(32*1024**3))
    (device/'mem_info_vram_used').write_text(str(64*1024**2))
    (device/'gpu_busy_percent').write_text('73\n')
    hwmon = device/'hwmon/hwmon0'; hwmon.mkdir(parents=True)
    (hwmon/'temp1_input').write_text('61500')
    (hwmon/'power1_average').write_text('123000000')
    return proc, device, hwmon


def test_gpu_activity_comes_from_sensors_and_survives_missing_sensor(tmp_path):
    proc, device, hwmon = fake_sysfs(tmp_path)
    reading = gpu_status(tmp_path)
    assert reading['available'] and reading['supported']
    assert reading['utilization_percent'] == 73
    assert reading['temperature_c'] == 61.5
    assert reading['power_w'] == 123
    assert reading['sampled_at'].endswith('+00:00')
    (hwmon/'power1_average').unlink()
    (device/'gpu_busy_percent').write_text('unavailable')
    (proc/'1234').mkdir()
    reading = gpu_status(tmp_path)
    assert not reading['available'] and reading['supported']
    assert reading['power_w'] is None and reading['utilization_percent'] is None
    assert reading['temperature_c'] == 61.5
    (device/'mem_info_vram_used').unlink()
    assert not gpu_status(tmp_path)['available']


def test_gpu_without_driver_never_claims_zero_utilization(tmp_path):
    reading = gpu_status(tmp_path)
    assert not reading['available'] and not reading['supported']
    assert reading['utilization_percent'] is None
    assert reading['temperature_c'] is None
    assert reading['power_w'] is None


def test_qwen38_cache_probe_is_read_only_and_cannot_create_missing_volume(tmp_path):
    runtime = Runtime(Store(tmp_path), {'qwen38_image': 'installed-qwen38', 'qwen38_cache_volume': 'existing-cache'})
    calls = []
    def command(args, **kwargs):
        calls.append(args)
        return CompletedProcess(args, 0, '', '')
    runtime.command = command
    assert runtime.preflight({'task': 'write', 'profile': profile('qwen38-writing', 'write')}) == 'installed-qwen38'
    probe = next(args for args in calls if args[0] == 'run')
    assert probe[probe.index('--network')+1] == 'none'
    assert '--read-only' in probe and '--device' not in probe
    assert 'type=volume,src=existing-cache,dst=/base,readonly,volume-nocopy' in probe
    calls.clear()
    def missing_volume(args, **kwargs):
        calls.append(args)
        return CompletedProcess(args, 1 if args[:2] == ['volume', 'inspect'] else 0, '', '')
    runtime.command = missing_volume
    with pytest.raises(RuntimeFailure, match='will not create'): runtime.preflight({'profile': profile('qwen38-writing', 'write')})
    assert all(args[0] != 'run' for args in calls)
    runtime.config['qwen38_cache_volume'] = '/arbitrary/host/path'
    with pytest.raises(RuntimeFailure): runtime.chat_source('qwen38', profile('qwen38-writing', 'write')['revision'])


def test_qwen38_runs_its_native_api_and_offline_source_contract(tmp_path, monkeypatch):
    monkeypatch.setattr('studio.runtime.gpu_status', lambda: {'driver_available': True, 'gpu_count': 1, 'name': 'AMD Radeon AI PRO R9700', 'architecture': 'gfx1201', 'total': 32*1024**3})
    store = Store(tmp_path); project = store.create_project()
    request = {'task': 'write', 'profile': profile('qwen38-writing', 'write'), 'prompt': 'Write a short factual caption.'}
    job = store.enqueue(project['id'], request)
    runtime = Runtime(store, {'qwen38_cache_volume': 'existing-cache'})
    runtime.preflight = lambda request: 'installed-qwen38'
    starts = []
    def start(job, image, args, **kwargs):
        starts.append((image, args, kwargs))
        return 'owned-container', store.root/'jobs'/job['id']
    runtime.start = start
    ready = []
    runtime.wait_ready = lambda job, container, port, path: ready.append((port, path))
    runtime.http = lambda *args, **kwargs: {'count':100}
    stopped = []
    runtime.stop = stopped.append
    def command(args, **kwargs):
        if args[0] == 'exec':
            (store.root/'jobs'/job['id']/'writing-result.json').write_text(json.dumps({'choices': [{'message': {'content': 'A factual draft.'}, 'finish_reason': 'stop'}], 'usage': {'completion_tokens': 4}}))
        return CompletedProcess(args, 0, '', '')
    runtime.command = command
    kind, path, metadata = runtime.run(job)
    assert kind == 'text' and path.read_text() == 'A factual draft.'
    assert starts[0][1] == []  # Qwen3.8 does not accept Qwen-Coder's --offline flag.
    assert starts[0][2]['mounts'] == [('existing-cache', '/base')]
    assert starts[0][2]['env']['PAITON_BASE_MODEL'].endswith('/'+request['profile']['revision'])
    assert ready == [(8000, '/health')]
    body = json.loads((store.root/'jobs'/job['id']/'writing-request.json').read_text())
    assert body['port'] == 8000 and body['body']['model'] == 'qwen38'
    assert body['body']['max_tokens'] == 2048
    assert metadata['finish_reason'] == 'stop' and metadata['text_only']
    assert stopped == [] and runtime.warm_live()
    runtime.drop_warm()
    assert stopped == ['owned-container']


def test_coder_cache_requires_tokenizer_index_and_every_complete_shard(tmp_path, monkeypatch):
    from studio import runtime as module
    revision = profile('writing-standard', 'write')['revision']
    hub = tmp_path/'hub'
    snapshot = hub/'models--cyankiwi--Qwen3-Coder-30B-A3B-Instruct-AWQ-4bit'/'snapshots'/revision
    snapshot.mkdir(parents=True)
    runtime = Runtime(Store(tmp_path/'data'), {'writing_image': 'installed-coder', 'writing_hub_dir': str(hub)})
    runtime.command = lambda args, **kwargs: CompletedProcess(args, 0, '', '')
    selected = {'profile': profile('writing-standard', 'write')}
    (snapshot/'config.json').write_text('{}')
    with pytest.raises(RuntimeFailure, match='incomplete'):
        runtime.preflight(selected)
    index = json.dumps({'weight_map': {'tensor_a': 'one.safetensors', 'tensor_b': 'two.safetensors'}}).encode()
    monkeypatch.setattr(module, 'CODER_SUPPORT_SIZES', {'config.json': 2, 'tokenizer.json': 2, 'tokenizer_config.json': 2, 'model.safetensors.index.json': len(index)})
    monkeypatch.setattr(module, 'CODER_SHARD_SIZES', {'one.safetensors': 16, 'two.safetensors': 16})
    import hashlib
    monkeypatch.setattr(module, 'CODER_INDEX_SHA256', hashlib.sha256(index).hexdigest())
    for name in ('tokenizer.json', 'tokenizer_config.json'): (snapshot/name).write_text('{}')
    (snapshot/'model.safetensors.index.json').write_bytes(index)
    shard = (2).to_bytes(8, 'little')+b'{}'+b'123456'
    (snapshot/'one.safetensors').write_bytes(shard)
    with pytest.raises(RuntimeFailure, match='incomplete'):
        runtime.preflight(selected)
    (snapshot/'two.safetensors').write_bytes(shard[:-1])
    with pytest.raises(RuntimeFailure, match='incomplete'):
        runtime.preflight(selected)
    (snapshot/'two.safetensors').write_bytes(shard)
    assert runtime.preflight(selected) == 'installed-coder'
    (snapshot/'tokenizer.json').unlink()
    with pytest.raises(RuntimeFailure, match='incomplete'):
        runtime.preflight(selected)
    (snapshot/'tokenizer.json').write_text('{}')
    (snapshot/'two.safetensors').write_bytes(bytes(16))
    with pytest.raises(RuntimeFailure, match='invalid header'):
        runtime.preflight(selected)


def test_old_hardware_wording_does_not_change_profile_execution_settings():
    old = profile('qwen38-writing', 'write')
    old['hardware']['qualification'] = 'An earlier explanation.'
    old['hardware']['required_vram_gib'] = 1
    checked = validate_snapshot(old, 'write')
    assert checked['hardware']['required_vram_gib'] == 32
    assert checked['hardware']['qualification'] != old['hardware']['qualification']
    old['max_tokens'] += 1
    with pytest.raises(ValueError): validate_snapshot(old, 'write')


def test_suspended_gpu_reports_power_state_without_inventing_sensor_values(tmp_path):
    _,device,hwmon=fake_sysfs(tmp_path)
    (device/'power').mkdir()
    (device/'power/runtime_status').write_text('suspended\n')
    (device/'gpu_busy_percent').unlink()
    (hwmon/'temp1_input').unlink()
    reading=gpu_status(tmp_path)
    assert reading['power_state']=='suspended'
    assert reading['utilization_percent'] is None
    assert reading['temperature_c'] is None
    assert reading['available'] is True
    (device/'power/runtime_status').write_text('unknown-driver-value')
    assert gpu_status(tmp_path)['power_state'] is None
