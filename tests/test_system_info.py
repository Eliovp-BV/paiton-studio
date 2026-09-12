"""Host inventory tests never launch containers or read real GPU devices."""
import json
import subprocess
import pytest

from studio import system_info
from studio.system_info import SystemInfo, environment_compatibility


@pytest.fixture
def host(tmp_path, monkeypatch):
    root = tmp_path / 'sys'
    proc = tmp_path / 'proc'
    proc.mkdir()
    (root / 'class/drm').mkdir(parents=True)
    (root / 'module/amdgpu').mkdir(parents=True)
    (root / 'module/amdgpu/version').write_text('6.19.14.31400000')
    (proc / 'meminfo').write_text('MemTotal: 16000 kB\nMemAvailable: 9000 kB\nSwapTotal: 4000 kB\nSwapFree: 3000 kB\n')
    monkeypatch.delenv('DOCKER_HOST', raising=False)
    monkeypatch.delenv('DOCKER_CONTEXT', raising=False)
    monkeypatch.setattr(system_info.platform, 'system', lambda: 'Linux')
    monkeypatch.setattr(system_info.platform, 'release', lambda: '6.17.0-1028-oem')
    monkeypatch.setattr(system_info.platform, 'machine', lambda: 'x86_64')
    monkeypatch.setattr(system_info.platform, 'freedesktop_os_release', lambda: {'PRETTY_NAME': 'Test Linux', 'ID': 'test', 'VERSION_ID': '1'})
    monkeypatch.setattr(system_info, 'gpu_status', lambda sys_root: {'gpu_count': 1, 'name': 'Qualified Radeon', 'architecture': 'gfx1201'})
    monkeypatch.setattr(system_info.subprocess, 'run', lambda *a, **k: pytest.fail('Unexpected subprocess'))
    return SystemInfo(tmp_path / 'data', sys_root=root, proc_root=proc)


def docker_available(monkeypatch, root, calls=None):
    calls = [] if calls is None else calls
    def run(args, **kwargs):
        assert isinstance(args, list) and args[0] == 'docker'
        assert 0 < kwargs['timeout'] <= 1.5
        assert not kwargs.get('shell')
        calls.append(args)
        if args[1] == 'context':
            body = 'unix:///var/run/docker.sock'
        elif args[1] == 'version':
            body = {'Client': {'Version': '29.7.2'}, 'Server': {'Version': '29.7.2', 'ApiVersion': '1.55',
                    'Os': 'linux', 'Arch': 'amd64', 'KernelVersion': '6.17.0-1028-oem'}}
        elif args[1] == 'info':
            body = str(root)
        else:
            pytest.fail('Probe attempted an unexpected Docker operation')
        return subprocess.CompletedProcess(args, 0, json.dumps(body), '')
    monkeypatch.setattr(system_info.subprocess, 'run', run)
    return calls


def make_gpu(host, pci, vendor='0x1002', memory=32 * 1024**3, unique=None, number=1):
    target = host.sys_root / 'devices' / pci
    target.mkdir(parents=True)
    for name, value in {'vendor': vendor, 'device': '0x7550', 'revision': '0xc0'}.items():
        (target / name).write_text(value)
    if memory is not None:
        (target / 'mem_info_vram_total').write_text(str(memory))
        (target / 'mem_info_vram_used').write_text('123')
    if unique is not None:
        (target / 'unique_id').write_text(unique)
    for node in (f'card{number}', f'renderD{127 + number}'):
        directory = host.sys_root / 'class/drm' / node
        directory.mkdir()
        (directory / 'device').symlink_to(target)
    return target


def test_snapshot_reports_driver_container_boundary_and_both_disks(host, monkeypatch, tmp_path):
    docker_root = tmp_path / 'docker'
    docker_root.mkdir()
    calls = docker_available(monkeypatch, docker_root)
    make_gpu(host, '0000:03:00.0', unique='abc123')
    result = host.snapshot()
    assert result['driver']['version'] == '6.19.14.31400000'
    assert result['driver']['container_rocm_version'] is None
    assert result['docker']['server_version'] == '29.7.2'
    assert result['memory']['available_bytes'] == 9000 * 1024
    assert result['memory']['swap_free_bytes'] == 3000 * 1024
    assert result['storage']['data']['probe_path'] == str(tmp_path)
    assert result['storage']['docker']['probe_path'] == str(docker_root)
    assert result['gpus'][0]['id'] == '0x1002:abc123'
    assert result['gpus'][0]['pci_address'] == '0000:03:00.0'
    assert result['gpus'][0]['render_nodes'] == ['/dev/dri/renderD128']
    assert result['gpus'][0]['architecture'] == 'gfx1201'
    assert [call[1] for call in calls] == ['context', 'version', 'info']


def test_snapshot_cache_is_isolated_from_caller_changes(host, monkeypatch, tmp_path):
    calls = docker_available(monkeypatch, tmp_path)
    first = host.snapshot()
    first['docker']['available'] = False
    assert host.snapshot()['docker']['available']
    assert len(calls) == 3
    host.snapshot(force=True)
    assert len(calls) == 6


def test_remote_daemon_is_not_contacted(host, monkeypatch):
    monkeypatch.setenv('DOCKER_HOST', 'ssh://private-host.example')
    result = host.snapshot()
    assert result['docker']['local_daemon'] is False
    assert result['docker']['available'] is False
    assert 'private-host.example' not in json.dumps(result)
    assert result['storage']['docker']['state'] == 'unknown'


def test_remote_context_is_not_contacted(host, monkeypatch):
    calls = []
    def context(args, **kw):
        calls.append(args)
        assert args[1] == 'context'
        return subprocess.CompletedProcess(args, 0, '"tcp://192.0.2.20:2376"', '')
    monkeypatch.setattr(system_info.subprocess, 'run', context)
    assert host.snapshot()['docker']['local_daemon'] is False
    assert len(calls) == 1


def test_explicit_context_takes_precedence_over_host_environment(host, monkeypatch, tmp_path):
    monkeypatch.setenv('DOCKER_HOST', 'ssh://unused.example')
    monkeypatch.setenv('DOCKER_CONTEXT', 'local-context')
    calls = docker_available(monkeypatch, tmp_path)
    assert host.snapshot()['docker']['available']
    assert calls[0][1] == 'context'


def test_malformed_docker_version_does_not_crash_system_endpoint(host, monkeypatch):
    def run(args, **kwargs):
        body = 'unix:///var/run/docker.sock' if args[1] == 'context' else {'Client': [], 'Server': 'invalid'}
        return subprocess.CompletedProcess(args, 0, json.dumps(body), '')
    monkeypatch.setattr(system_info.subprocess, 'run', run)
    assert host.snapshot()['docker']['available'] is False


@pytest.mark.parametrize('error', [FileNotFoundError('missing'), subprocess.TimeoutExpired('docker', 1.5)])
def test_missing_or_hung_docker_keeps_host_inventory_available(host, monkeypatch, error):
    def fail(*args, **kwargs):
        raise error
    monkeypatch.setattr(system_info.subprocess, 'run', fail)
    snapshot = host.snapshot()
    assert snapshot['docker']['available'] is False
    assert snapshot['memory']['total_bytes'] == 16000 * 1024


def test_inventory_does_not_apply_radeon_architecture_to_intel_gpu(host, monkeypatch, tmp_path):
    docker_available(monkeypatch, tmp_path)
    make_gpu(host, '0000:03:00.0', unique='00000000')
    make_gpu(host, '0000:00:02.0', vendor='0x8086', memory=None, number=2)
    result = host.snapshot()
    radeon, intel = result['gpus']
    assert radeon['id'] == 'pci:0000:03:00.0'
    assert radeon['architecture'] == 'gfx1201'
    assert intel['architecture'] is None and intel['total_bytes'] is None
    assert len(result['gpus']) == 2


def test_inaccessible_or_missing_docker_root_is_not_replaced_with_host_disk(host, monkeypatch, tmp_path):
    docker_available(monkeypatch, tmp_path / 'not-mounted/docker')
    assert host.snapshot()['storage']['docker']['state'] == 'unknown'


def test_docker_vm_does_not_report_host_filesystem_capacity(host, monkeypatch, tmp_path):
    docker_available(monkeypatch, tmp_path)
    monkeypatch.setattr(system_info.platform, 'release', lambda: 'other-kernel')
    assert host.snapshot()['storage']['docker']['state'] == 'unknown'


def test_unknown_driver_memory_and_os_remain_unknown(host, monkeypatch, tmp_path):
    docker_available(monkeypatch, tmp_path)
    (host.sys_root / 'module/amdgpu/version').unlink()
    (host.proc_root / 'meminfo').write_text('MemTotal: -12 kB\nMemAvailable: invalid kB\n')
    monkeypatch.setattr(system_info.platform, 'system', lambda: 'Windows')
    result = host.snapshot()
    assert result['driver']['version'] is None
    assert result['memory']['total_bytes'] is None
    assert result['memory']['available_bytes'] is None
    assert result['platform']['distribution'] is None


def environment():
    return {'platform': {'system': 'Linux', 'machine': 'x86_64', 'release': '6.17.0-1028-oem'},
            'docker': {'os': 'linux', 'architecture': 'amd64', 'server_version': '29.7.2', 'api_version': '1.55'},
            'driver': {'version': '6.19.14.31400000'}}


def test_explicit_environment_requirements_accept_aliases_and_version_ranges():
    result = environment_compatibility({'systems': ['Linux'], 'machines': ['amd64'], 'docker_os': ['linux'],
        'docker_architectures': ['x86_64'], 'versions': {'docker_server': '>=29,<30', 'docker_api': '>=1.45'}}, environment())
    assert result['compatible'] and result['status'] == 'compatible'
    assert len(result['checks']) == 6


def test_wrong_platform_is_rejected_even_when_gpu_has_enough_memory():
    result = environment_compatibility({'systems': ['Windows'], 'versions': {'docker_server': '>=30'}}, environment())
    assert not result['compatible'] and result['status'] == 'incompatible'
    assert len(result['reasons']) == 2


@pytest.mark.parametrize('requirements', [
    {'versions': {'container_rocm': '>=7'}}, {'versions': {'kernel': '>=6.8'}},
    {'versions': {'host_driver': 'not a version range'}}, {'versions': {'docker_server': ''}},
    {'cuda': True}, {'systems': 'Linux'}, {'systems': []}, {'versions': []}, False,
])
def test_unknown_or_malformed_requirements_fail_closed_with_reason(requirements):
    result = environment_compatibility(requirements, environment())
    assert result['status'] == 'unknown' and not result['compatible']
    assert result['reasons']


def test_unknown_required_version_is_not_guessed():
    snapshot = environment()
    snapshot['driver']['version'] = None
    result = environment_compatibility({'versions': {'host_driver': '>=6'}}, snapshot)
    assert result['status'] == 'unknown' and not result['compatible']


def test_undeclared_environment_does_not_claim_package_qualification():
    result = environment_compatibility({}, environment())
    assert result['compatible']
    assert 'does not qualify' in result['reason']
    assert result['checks'] == []


def test_host_rocm_active_core_and_legacy_layout(tmp_path):
    from studio.system_info import _host_rocm
    assert _host_rocm(tmp_path)['version'] is None
    legacy=tmp_path/'.info/version';legacy.parent.mkdir();legacy.write_text('7.14.0\n')
    assert _host_rocm(tmp_path)['version']=='7.14.0'
    core=tmp_path/'core/.info/version';core.parent.mkdir(parents=True);core.write_text('10.0.0\n')
    assert _host_rocm(tmp_path)==dict(version='10.0.0',source=str(core))
    core.write_text('unknown');legacy.unlink()
    assert _host_rocm(tmp_path)['version'] is None
