"""Read-only host facts, separate from package qualification and GPU admission.

No driver changes, model imports, device opens, container starts or external
requests occur here. Host amdgpu versions do not identify container ROCm. Unknown
facts remain null. Detailed probes are cached; live activity stays in telemetry.
"""
from copy import deepcopy
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import threading
import time

from packaging.specifiers import InvalidSpecifier, SpecifierSet
from packaging.version import InvalidVersion, Version

from .telemetry import gpu_status


def _read(path):
    try:
        return Path(path).read_text().strip() or None
    except (OSError, UnicodeError):
        return None


def _host_rocm(root):
    # ROCm 10 uses the selected core prefix; older installations use the root.
    # Read the active prefix only, never infer a version from a directory name.
    for relative in ('core/.info/version', '.info/version'):
        path = Path(root) / relative
        value = _read(path)
        if value and re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?', value):
            return dict(version=value, source=str(path))
    return dict(version=None, source=None)


def _bytes(path):
    try:
        value = int(_read(path))
        return value if value >= 0 else None
    except (TypeError, ValueError):
        return None


def _memory(proc_root):
    values = {}
    for line in (_read(Path(proc_root) / 'meminfo') or '').splitlines():
        key, _, raw = line.partition(':')
        fields = raw.split()
        if len(fields) == 2 and fields[0].isdigit() and fields[1] == 'kB':
            values[key] = int(fields[0]) * 1024
    return dict(total_bytes=values.get('MemTotal'), available_bytes=values.get('MemAvailable'),
                swap_total_bytes=values.get('SwapTotal'), swap_free_bytes=values.get('SwapFree'))


def _storage(path, *, allow_ancestor=True):
    result = dict(path=str(path) if path is not None else None, probe_path=None,
                  total_bytes=None, used_bytes=None, free_bytes=None, state='unknown')
    if path is None:
        return result
    path = Path(path)
    try:
        # The app data path can be not yet created. Record the ancestor actually
        # measured. Never guess an inaccessible Docker mount from another disk.
        while not path.exists():
            if not allow_ancestor or path == path.parent:
                return result
            path = path.parent
        usage = shutil.disk_usage(path)
        return {**result, 'probe_path': str(path), 'total_bytes': usage.total,
                'used_bytes': usage.used, 'free_bytes': usage.free, 'state': 'known'}
    except OSError:
        return result


def _gpus(sys_root, telemetry):
    drm = Path(sys_root) / 'class/drm'
    devices = {}
    for card in sorted(drm.glob('card[0-9]*')):
        if not re.fullmatch(r'card\d+', card.name):
            continue
        device = card / 'device'
        try:
            target = device.resolve(strict=True)
        except OSError:
            continue
        pci = target.name if re.fullmatch(r'[\da-fA-F]{4}:[\da-fA-F]{2}:[\da-fA-F]{2}\.[0-7]', target.name) else None
        vendor, identity = _read(device / 'vendor'), _read(device / 'device')
        unique = _read(device / 'unique_id')
        # Zero is not a useful serial number on cards that expose a placeholder.
        if unique and not unique.removeprefix('0x').strip('0'):
            unique = None
        stable_id = f'{vendor}:{unique}' if unique and vendor else f'pci:{pci}' if pci else f'drm:{card.name}'
        item = devices.setdefault(str(target), dict(
            id=stable_id, identity_source='unique_id' if unique else 'pci_address' if pci else 'drm_node',
            pci_address=pci, render_nodes=[], vendor_id=vendor, device_id=identity,
            revision_id=_read(device / 'revision'), name=_read(device / 'product_name'), architecture=None,
            total_bytes=_bytes(device / 'mem_info_vram_total'), used_bytes=_bytes(device / 'mem_info_vram_used')))
        for render in drm.glob('renderD*'):
            try:
                if (render / 'device').resolve(strict=True) == target:
                    node = '/dev/dri/' + render.name
                    if node not in item['render_nodes']:
                        item['render_nodes'].append(node)
            except OSError:
                continue
    items = list(devices.values())
    radeons = [item for item in items if item['vendor_id'] == '0x1002' and item['total_bytes'] is not None]
    if len(radeons) == 1 and telemetry.get('gpu_count') == 1:
        radeons[0]['architecture'] = telemetry.get('architecture')
        radeons[0]['name'] = radeons[0]['name'] or telemetry.get('name')
    return items


def _docker():
    result = dict(available=False, client_version=None, server_version=None, api_version=None,
                  os=None, architecture=None, kernel_version=None, root_dir=None, local_daemon=None,
                  message='Docker could not be inspected. Install or start the local Docker Engine.')
    deadline = time.monotonic() + 4.5

    def probe(args):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return None
        try:
            command = subprocess.run(['docker', *args], capture_output=True, text=True,
                                     timeout=min(1.5, remaining), check=False)
            # Docker version can still supply useful client facts if the daemon
            # is unavailable. Never return raw stderr/configuration to clients.
            return json.loads(command.stdout) if command.stdout.strip() else None
        except (OSError, subprocess.TimeoutExpired, ValueError):
            return None

    # Inspect local CLI metadata before any daemon query. A remote Docker context
    # cannot safely represent the same host whose GPU and filesystem we inspect.
    endpoint = os.environ.get('DOCKER_HOST') if not os.environ.get('DOCKER_CONTEXT') else None
    if not endpoint:
        endpoint = probe(['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'])
    if not isinstance(endpoint, str):
        return {**result, 'message': 'The local Docker context could not be identified.'}
    if not endpoint.startswith(('unix://', 'npipe://')):
        return {**result, 'local_daemon': False,
                'message': 'Docker selects a remote or TCP daemon. Studio needs a local Docker Engine on the GPU host.'}
    result['local_daemon'] = True
    version = probe(['version', '--format', '{{json .}}'])
    if not isinstance(version, dict):
        return result
    client, server = version.get('Client') or {}, version.get('Server') or {}
    if not isinstance(client, dict) or not isinstance(server, dict):
        return result
    result.update(client_version=client.get('Version'), server_version=server.get('Version'),
                  api_version=server.get('ApiVersion'), os=server.get('Os'), architecture=server.get('Arch'),
                  kernel_version=server.get('KernelVersion'), available=bool(server.get('Version')))
    if result['available']:
        root = probe(['info', '--format', '{{json .DockerRootDir}}'])
        result['root_dir'] = root if isinstance(root, str) and root.startswith('/') else None
        result['message'] = 'Local Docker Engine detected. Package eligibility is checked separately.'
    return result


class SystemInfo:
    """One cached, serializable host inventory per Studio controller."""

    def __init__(self, data_dir, *, sys_root='/sys', proc_root='/proc', dev_root='/dev', rocm_root='/opt/rocm', cache_seconds=10):
        self.data_dir = Path(data_dir).resolve()
        self.sys_root, self.proc_root = Path(sys_root), Path(proc_root)
        self.dev_root = Path(dev_root)
        self.rocm_root = Path(rocm_root)
        self.cache_seconds = max(5, min(15, cache_seconds))
        self._cached = None
        self._sampled = 0
        self._lock = threading.Lock()

    def snapshot(self, force=False):
        with self._lock:
            if force or self._cached is None or time.monotonic() - self._sampled >= self.cache_seconds:
                self._cached = self._collect()
                self._sampled = time.monotonic()
            return deepcopy(self._cached)

    def _collect(self):
        system, release = platform.system(), platform.release()
        try:
            distribution = platform.freedesktop_os_release() if system == 'Linux' else {}
        except OSError:
            distribution = {}
        gpu = gpu_status(self.sys_root)
        docker = _docker()
        driver_path = self.sys_root / 'module/amdgpu/version'
        driver_version = _read(driver_path)
        host_rocm = _host_rocm(self.rocm_root) if system == "Linux" else dict(version=None, source=None)
        native_linux_daemon = (system == 'Linux' and docker['local_daemon'] is True and
                               docker['kernel_version'] == release)
        result = dict(
            schema_version=1, sampled_at=datetime.now(timezone.utc).isoformat(),
            cache_seconds=self.cache_seconds,
            platform=dict(system=system, release=release, machine=platform.machine(),
                          distribution=distribution.get('PRETTY_NAME'), distribution_id=distribution.get('ID'),
                          distribution_version=distribution.get('VERSION_ID'), wsl='microsoft' in release.lower()),
            python_version=platform.python_version(),
            driver=dict(name='amdgpu' if (self.sys_root / 'module/amdgpu').is_dir() else None,
                        version=driver_version, version_source='sysfs module version' if driver_version else None,
                        host_rocm_version=host_rocm["version"], host_rocm_source=host_rocm["source"],
                        container_rocm_version=None,
                        note='Host kernel driver only. Each Paiton runtime supplies its own ROCm userspace.'),
            docker=docker, gpu=gpu, gpus=_gpus(self.sys_root, gpu), memory=_memory(self.proc_root),
            storage=dict(data=_storage(self.data_dir),
                         docker=_storage(docker['root_dir'] if native_linux_daemon else None, allow_ancestor=False)),
            checks=[])
        kfd = self.dev_root / 'kfd'
        amd_nodes = [node for device in result['gpus'] if device['vendor_id']=='0x1002' for node in device['render_nodes']]
        result['device_access'] = dict(kfd_exists=kfd.exists(),
            kfd_read_write=os.access(kfd, os.R_OK | os.W_OK),
            inaccessible_render_nodes=[node for node in amd_nodes if not os.access(self.dev_root / 'dri' / Path(node).name, os.R_OK | os.W_OK)])
        result['checks'] = [
            dict(id='docker', status='known' if docker['available'] else 'unknown', message=docker['message']),
            dict(id='driver_version', status='known' if driver_version else 'unknown',
                 message='Host amdgpu module version detected.' if driver_version else 'The host amdgpu module does not report a version.'),
            dict(id='docker_storage', status=result['storage']['docker']['state'],
                 message='Docker filesystem capacity measured.' if result['storage']['docker']['state'] == 'known'
                 else 'Docker storage capacity could not be verified on the host filesystem.'),
        ]
        return result


def environment_compatibility(requirements, snapshot):
    """Evaluate reviewed metadata only; this does not qualify a GPU or package.

    Allowed fields: systems, machines, docker_os, docker_architectures (lists),
    and versions mapping kernel/docker_server/docker_api/host_driver to PEP 440
    specifiers. Unknown or malformed required facts fail closed, with an explicit
    unknown status. Linux distribution kernel suffixes are never stripped to
    invent comparable upstream versions. Missing requirements impose no gate.
    """
    checks = []

    def record(key, status, reason):
        checks.append(dict(id=key, status=status, reason=reason))

    if requirements is None:
        requirements = {}
    if not isinstance(requirements, dict):
        record('metadata', 'unknown', 'This package has invalid environment requirements.')
        requirements = {}
    platform_info, docker = snapshot.get('platform') or {}, snapshot.get('docker') or {}
    values = dict(systems=platform_info.get('system'), machines=platform_info.get('machine'),
                  docker_os=docker.get('os'), docker_architectures=docker.get('architecture'))
    aliases = {'x86_64': 'amd64', 'aarch64': 'arm64'}
    for key in requirements:
        if key not in {*values, 'versions'}:
            record(key, 'unknown', f'This Studio version cannot evaluate the {key} requirement.')
    for key, actual in values.items():
        if key not in requirements:
            continue
        allowed = requirements[key]
        if not isinstance(allowed, list) or not allowed or not all(isinstance(v, str) and v for v in allowed):
            record(key, 'unknown', f'The package declares invalid {key} requirements.')
        elif not isinstance(actual, str) or not actual:
            record(key, 'unknown', f'The required {key} value could not be detected.')
        else:
            normal = lambda v: aliases.get(v.lower(), v.lower()) if key in ('machines', 'docker_architectures') else v.lower()
            matches = normal(actual) in [normal(v) for v in allowed]
            record(key, 'compatible' if matches else 'incompatible',
                   f'Detected {actual}; package allows {", ".join(allowed)}.')
    versions = requirements.get('versions', {})
    current = dict(kernel=platform_info.get('release'), docker_server=docker.get('server_version'),
                   docker_api=docker.get('api_version'), host_driver=(snapshot.get('driver') or {}).get('version'))
    if not isinstance(versions, dict):
        record('versions', 'unknown', 'The package declares invalid version requirements.')
    else:
        for key, spec in versions.items():
            actual = current.get(key)
            try:
                if key not in current or not isinstance(spec, str) or not spec.strip() or not isinstance(actual, str):
                    raise ValueError()
                supported = Version(actual) in SpecifierSet(spec)
                record(key, 'compatible' if supported else 'incompatible', f'Detected {actual}; package requires {spec}.')
            except (InvalidVersion, InvalidSpecifier, ValueError, TypeError):
                record(key, 'unknown', f'The required {key} version range could not be verified.')
    statuses = {check['status'] for check in checks}
    status = 'incompatible' if 'incompatible' in statuses else 'unknown' if 'unknown' in statuses else 'compatible'
    reasons = [check['reason'] for check in checks if check['status'] != 'compatible']
    return dict(compatible=status == 'compatible', status=status, checks=checks, reasons=reasons,
                reason=' '.join(reasons) if reasons else 'Declared environment requirements are met.' if checks
                else 'No additional environment requirements were declared; this does not qualify the package.')
