"""Read-only Linux Radeon identity and telemetry; unavailable sensors stay null."""
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path


def _number(path, divisor=1):
    try:
        return int(path.read_text().strip()) / divisor
    except (OSError, ValueError, OverflowError):
        return None


def _read(path):
    try: return path.read_text().strip()
    except OSError: return None


@lru_cache(maxsize=64)
def _marketing_name(vendor, device, revision):
    """Use the installed AMD PCI ID database, including revision, not a guess."""
    if vendor != '0x1002' or not device or not revision:
        return None
    sources = list(Path('/opt/rocm').glob('*/lib/rocm_sysdeps/share/libdrm/amdgpu.ids'))
    sources += [Path('/usr/share/libdrm/amdgpu.ids'), Path('/usr/share/hwdata/amdgpu.ids')]
    for source in sources:
        try:
            for line in source.read_text().splitlines():
                fields = [part.strip() for part in line.split(',', 2)]
                if len(fields) == 3 and fields[0].lower() == device.removeprefix('0x').lower() and fields[1].lower() == revision.removeprefix('0x').lower():
                    return fields[2]
        except OSError:
            continue
    return None


def _architecture(version):
    major = version//10000
    minor = (version//100)%100
    stepping = version%100
    return f'gfx{major}{minor:x}{stepping:x}'


def gpu_status(sys_root=Path('/sys')):
    root = Path(sys_root)
    result = dict(available=False, supported=False, driver_available=False, pids=[], total=None, used=None,
                  gpu_count=0, name=None, architecture=None, architectures=[],
                  utilization_percent=None, temperature_c=None, power_w=None, power_state=None,
                  sampled_at=datetime.now(timezone.utc).isoformat())
    proc = root/'class/kfd/kfd/proc'
    if not proc.is_dir():
        return {**result, 'message': 'The Radeon driver is unavailable.'}
    try:
        result['pids'] = [int(p.name) for p in proc.iterdir() if p.name.isdigit()]
        cards = [p for p in (root/'class/drm').glob('card*/device/mem_info_vram_total')
                 if _read(p.with_name('vendor')) in (None, '0x1002')]
        # DRM aliases can refer to the same physical PCI device. Count it once.
        cards = list({p.parent.resolve(): p for p in cards}.values())
        result['gpu_count'] = len(cards)
        result['driver_available'] = True
        totals = [_number(p) for p in cards]
        used = [_number(p.with_name('mem_info_vram_used')) for p in cards]
        if not cards or any(t is None or t <= 0 for t in totals) or any(u is None or u < 0 for u in used) or any(u > t for t, u in zip(totals, used) if t is not None and u is not None):
            return {**result, 'message': 'GPU memory availability could not be checked.'}
        # No pooled-memory claim: current adapters have no multi-device dispatch.
        result.update(total=int(totals[0]) if len(cards) == 1 else None,
                      used=int(used[0]) if len(cards) == 1 else None)
        if len(cards) == 1:
            device = cards[0].parent
            power_state = _read(device/'power/runtime_status')
            result['power_state'] = power_state if power_state in ('active','suspended','resuming','suspending') else None
            result['name'] = _read(device/'product_name') or _marketing_name(_read(device/'vendor'), _read(device/'device'), _read(device/'revision'))
            busy = _number(device/'gpu_busy_percent')
            result['utilization_percent'] = busy if busy is not None and 0 <= busy <= 100 else None
            for hwmon in sorted((device/'hwmon').glob('hwmon*')):
                if result['temperature_c'] is None:
                    result['temperature_c'] = _number(hwmon/'temp1_input', 1000)
                if result['power_w'] is None:
                    result['power_w'] = _number(hwmon/'power1_average', 1_000_000)
        targets = []
        for path in (root/'class/kfd/kfd/topology/nodes').glob('*/properties'):
            properties = dict(line.split(maxsplit=1) for line in path.read_text().splitlines() if ' ' in line)
            version = int(properties.get('gfx_target_version', '0'))
            if version:
                targets.append(version)
        result['architectures'] = [_architecture(version) for version in targets]
        result['architecture'] = result['architectures'][0] if len(targets) == 1 else None
        # 'supported' describes detectable single-GPU control. Each selected
        # package enforces its own architecture, capacity and device contract.
        supported = len(cards) == 1 and len(targets) == 1
        available = supported and not result['pids'] and result['used'] < 1024**3
        message = 'GPU available' if available else 'Another application is using the GPU. Your request will wait.'
        if not supported:
            message = 'Studio needs one identifiable Radeon GPU for these local adapters.'
        return {**result, 'available': available, 'supported': supported, 'message': message}
    except (OSError, ValueError):
        return {**result, 'message': 'GPU availability could not be checked.'}
