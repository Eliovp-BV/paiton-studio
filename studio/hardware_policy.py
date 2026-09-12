"""Pure, versioned hardware admission policy. No probes, processes or downloads.

Keep qualification separate from activity. Report every blocker so fixing one
requirement never implies an untested board has become qualified.
"""
import math

FIELDS = {'schema_version', 'supported_architectures', 'required_device_names',
          'required_vram_gib', 'minimum_reported_vram_gib', 'qualification', 'memory_basis'}


def positive(value):
    try:
        return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value > 0
    except OverflowError:
        return False


def strings(value, *, empty=False):
    return isinstance(value, list) and (empty or bool(value)) and all(isinstance(v, str) and v.strip() for v in value)


def evaluate(requirements, gpu, *, integrated=True):
    checks = []
    result = dict(schema_version=1, compatible=False, status='unknown', reason='', reasons=[], checks=checks,
                  required_vram_gib=None, minimum_reported_vram_gib=None, detected_vram_gib=None,
                  supported_architectures=[], required_device_names=[], qualification=None, memory_basis=None)

    def record(identity, status, message):
        checks.append(dict(id=identity, status=status, message=message))

    def finish():
        blockers = [c for c in checks if c['status'] != 'compatible']
        result['compatible'] = not blockers
        result['status'] = ('incompatible' if any(c['status'] == 'incompatible' for c in blockers)
                            else 'unknown' if blockers else 'compatible')
        result['reasons'] = [c['message'] for c in blockers]
        result['reason'] = result['reasons'][0] if blockers else 'Compatible with this GPU. Current activity is handled by the queue.'
        return result

    if not isinstance(requirements, dict) or not isinstance(gpu, dict):
        record('qualification', 'unknown', 'This package has no qualified hardware requirements yet.')
        return finish()
    architectures = requirements.get('supported_architectures', [])
    names = requirements.get('required_device_names', [])
    required = requirements.get('required_vram_gib')
    minimum = requirements.get('minimum_reported_vram_gib', required)
    version = requirements.get('schema_version', 1)
    if (integrated is False or type(version) is not int or version != 1 or set(requirements) - FIELDS
            or not strings(architectures) or not strings(names, empty=True)
            or not positive(required) or not positive(minimum) or minimum > required):
        record('qualification', 'unknown', 'This package has no qualified hardware requirements yet. Its policy is missing, invalid or newer than this Studio version.')
        return finish()
    total = gpu.get('total')
    detected = total / 1024**3 if positive(total) else None
    result.update(required_vram_gib=required, minimum_reported_vram_gib=minimum,
                  detected_vram_gib=detected, supported_architectures=architectures,
                  required_device_names=names, qualification=requirements.get('qualification'),
                  memory_basis=requirements.get('memory_basis'))
    record('driver', 'compatible' if gpu.get('driver_available', gpu.get('supported', False)) is True else 'unknown',
           'Radeon driver identified.' if gpu.get('driver_available', gpu.get('supported', False)) is True
           else 'The Radeon driver or GPU identification is unavailable.')
    count = gpu.get('gpu_count', 1)
    single = type(count) is int and count == 1
    record('device_count', 'compatible' if single else 'incompatible',
           'One GPU is identified for this adapter.' if single else 'This package requires exactly one GPU for generation. Memory from different GPUs is not combined.')
    architecture = gpu.get('architecture')
    record('architecture', 'compatible' if architecture in architectures else 'incompatible' if architecture else 'unknown',
           f'Architecture {architecture} is qualified.' if architecture in architectures else
           'This package requires '+', '.join(architectures)+'; detected '+str(architecture or 'an unknown architecture')+'.')
    enough = detected is not None and detected >= minimum
    record('capacity', 'compatible' if enough else 'incompatible' if detected is not None else 'unknown',
           f'{detected:.1f} GiB meets the {minimum:g} GiB usable capacity minimum.' if enough else
           f'This profile requires a {required:g} GB card ({minimum:g} GiB usable capacity minimum); this card reports {detected:.1f} GiB.' if detected is not None else
           'The graphics card memory capacity could not be read.')
    matched = not names or gpu.get('name') in names
    record('device_qualification', 'compatible' if matched else 'incompatible' if gpu.get('name') else 'unknown',
           'Device identity meets this package’s qualification policy.' if matched else
           'This installed package is qualified for '+', '.join(names)+'. Detected '+str(gpu.get('name') or 'an unidentified GPU')+'. Enough memory alone does not qualify another card.')
    return finish()
