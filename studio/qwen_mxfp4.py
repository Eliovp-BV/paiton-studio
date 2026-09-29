"""Pinned local Qwen sources for legacy 200K and ROCm 10 MXFP4/W3A4.

Only public release metadata lives here. Studio verifies new runtime sources;
the ROCm 10 entrypoint does not implement the legacy checkpoint verifier.
"""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import threading
import uuid

from .conversation_options import CONTRACTS
from .store import safe_path


REPOSITORY = 'ghcr.io/eliovp/paiton-vllm-plugin'
IMAGE_ID = 'sha256:487c97d51e5b4a3fcd0a206e53d842a52dd56a199d8ee3e884f48815093a80d4'
IMAGE = REPOSITORY + '@' + IMAGE_ID
PREVIOUS_65K_IMAGE = REPOSITORY + '@sha256:c4134aba665f6dd3b89354a43be2b5b814f7078db456351647a3f1b106a0da49'
ROCM10_IMAGES = (IMAGE, PREVIOUS_65K_IMAGE)
LEGACY_64K_IMAGE = REPOSITORY + '@sha256:c3ec2528285b484b2e0af7f571f80f1da23c1970210e4d3d09f5d2a909414186'
LEGACY_200K_IMAGE = REPOSITORY + '@sha256:28af1731cfd8aceab51915411e8f879531128c2711b4193c76c5b6eba8ba2ef4'
LEGACY_IMAGES = (LEGACY_64K_IMAGE, LEGACY_200K_IMAGE)
APPROVED_IMAGES = (*ROCM10_IMAGES, *LEGACY_IMAGES)
# Published component notices for the unified release.
SOURCE_REVISION = 'a2496827b761c284840c7813d584eb0b044d6c79'
_LEGACY_RAW = (CONTRACTS / 'qwen38-mxfp4-checkpoints.json').read_bytes()
_NEW_RAW = (Path(__file__).parent / 'contracts/qwen38-rocm10-checkpoints.json').read_bytes()
LEGACY_MANIFEST_SHA256 = hashlib.sha256(_LEGACY_RAW).hexdigest()
MANIFEST_SHA256 = hashlib.sha256(_NEW_RAW).hexdigest()
MODELS = json.loads(_LEGACY_RAW)['models']
_NEW_CONTRACT = json.loads(_NEW_RAW)
NEW_MODELS = _NEW_CONTRACT['models']
OPTIONAL_COMPONENTS = _NEW_CONTRACT['optional_components']
# Existing profile snapshots retain their original revision; the resolved
# execution contract records the selected target revision separately.
REVISION = MODELS['target']['revision']
DOWNLOAD_BYTES = sum(record['bytes'] for spec in NEW_MODELS.values()
                     for record in spec['files'].values())
W3_DOWNLOAD_BYTES = sum(record['bytes'] for record in OPTIONAL_COMPONENTS['w3a4']['files'].values())
W3_DEFAULT_KEY = 'qwen38_w3a4_default'
W3_NOTE = ('Earlier FP8-cache benchmarks: decode about 20% faster; MMLU-Pro -2.9 points; '
           'GSM8K and HumanEval within noise. KV4 results differ.')
_VERIFIED = {}
_VERIFY_LOCK = threading.RLock()
_VOLUME_NAME = re.compile(r'[a-zA-Z0-9][a-zA-Z0-9_.-]*\Z')


def _reference(value):
    if value in APPROVED_IMAGES:
        return value
    return next((reference for reference in APPROVED_IMAGES if value == reference.split('@')[1]), None)


def verify_image(inspected, expected=IMAGE):
    """Return an approved immutable reference, including classic Docker IDs."""
    try:
        images = json.loads(inspected)
        if not isinstance(images, list) or len(images) != 1 or not isinstance(images[0], dict):
            raise ValueError()
        image = images[0]
        digests = image.get('RepoDigests') or []
        if not isinstance(digests, list) or any(not isinstance(item, str) for item in digests):
            raise ValueError()
        reference = _reference(expected)
        if reference:
            if image.get('Id') == reference.split('@')[1] or reference in digests:
                return reference
        elif (isinstance(expected, str) and re.fullmatch(r'sha256:[0-9a-f]{64}', expected)
              and image.get('Id') == expected):
            matches = [reference for reference in APPROVED_IMAGES
                       if reference in digests]
            if len(matches) == 1:
                return matches[0]
    except (TypeError, ValueError, KeyError):
        pass
    raise ValueError('Install the pinned Qwen3.8 runtime. Qronos, tags and other Qwen images cannot serve this profile.')


def image_family(image, inspected=None):
    reference = verify_image(inspected, image) if inspected is not None else _reference(image)
    if reference is None:
        raise ValueError('Choose a pinned Qwen3.8 release image.')
    return 'rocm10' if reference in ROCM10_IMAGES else 'legacy'


def checkpoint_contract(image):
    new = image_family(image) == 'rocm10'
    return {'models': NEW_MODELS if new else MODELS,
            'optional_components': OPTIONAL_COMPONENTS if new else {},
            'sha256': MANIFEST_SHA256 if new else LEGACY_MANIFEST_SHA256}


def source_contract(config, image=IMAGE, weights='mxfp4'):
    """Resolve explicit folders or the same exact snapshot in a read-only cache."""
    legacy = image_family(image) == 'legacy'
    if weights not in ('mxfp4', 'w3a4') or legacy and weights != 'mxfp4':
        raise ValueError('W3A4 3-bit weights require a supported ROCm 10 runtime; legacy runtimes use MXFP4.')
    contract = checkpoint_contract(image)
    models = dict(contract['models'])
    if weights == 'w3a4':
        models['w3a4'] = OPTIONAL_COMPONENTS['w3a4']
    keys = {'target': 'qwen38_mxfp4_target_dir' if legacy else 'qwen38_nvfp4_target_dir',
            'draft': 'qwen38_mxfp4_draft_dir', 'w3a4': 'qwen38_w3rot_dir'}
    mounts, paths, components = [], {}, {}
    for role, spec in models.items():
        configured = config.get(keys[role])
        if configured is not None and configured != '':
            if not isinstance(configured, str) or not Path(configured).is_dir():
                raise ValueError('The configured Qwen ' + role + ' folder is missing. Open Models to repair setup.')
            source = str(Path(configured).resolve())
            container = '/models/' + ('w3rot' if role == 'w3a4' else role)
            mounts.append((source, container))
            components[role] = {'directory': source, 'spec': spec, 'path': container}
        else:
            volume = config.get('qwen38_mxfp4_cache_volume')
            if role == 'w3a4' or not isinstance(volume, str) or not _VOLUME_NAME.fullmatch(volume):
                raise ValueError('Qwen needs its pinned target and DFlash2 draft folders'
                                 + (' and verified Faster 3-bit weights' if weights == 'w3a4' else '')
                                 + '. Open Models to finish setup.')
            mount = (volume, '/pinned-cache')
            if mount not in mounts:
                mounts.append(mount)
            container = '/pinned-cache/hub/models--' + spec['repository'].replace('/', '--') + '/snapshots/' + spec['revision']
            components[role] = {'volume': volume, 'spec': spec, 'path': container}
        paths[role] = container
    environment = {}
    if not legacy:
        environment = {name: '1' if weights == 'w3a4' else '0'
                       for name in ('PAITON_W3_DECODE', 'PAITON_W3_PREFILL', 'PAITON_W3_A4')}
        if weights == 'w3a4':
            environment.update(PAITON_W3ROT_DIR=paths['w3a4'], PAITON_W3_A4_DIR=paths['w3a4'],
                               PYTORCH_ALLOC_CONF='max_split_size_mb:64')
    return {'mounts': mounts, 'paths': paths, 'components': components, 'environment': environment,
            'manifest_sha256': contract['sha256'], 'weights': weights, 'legacy': legacy}


def sources(config, image=LEGACY_64K_IMAGE, weights='mxfp4'):
    """Legacy caller compatibility; new launchers consume source_contract paths."""
    selected = source_contract(config, image, weights)
    arguments = ['--offline', '--target', selected['paths']['target'], '--draft', selected['paths']['draft']]
    return selected['mounts'], arguments


def _fingerprint(directory, spec):
    result = []
    for name, record in spec['files'].items():
        path = directory / name
        try:
            info = path.stat()
            if not path.is_file() or info.st_size != record['bytes']:
                raise OSError()
            result.append((name, str(path.resolve()), info.st_dev, info.st_ino, info.st_size,
                           info.st_mtime_ns, info.st_ctime_ns))
        except OSError:
            raise ValueError('Qwen model files are missing or incomplete. Open Models to download or repair them.') from None
    return tuple(result)


def _verification_key(directory, spec):
    return (str(directory.resolve()), hashlib.sha256(json.dumps(spec, sort_keys=True).encode()).hexdigest())


def verify_folder(directory, spec):
    """Hash all tensors once per file identity; recheck before warm reuse."""
    directory = Path(directory)
    with _VERIFY_LOCK:
        fingerprint = _fingerprint(directory, spec)
        key = _verification_key(directory, spec)
        if _VERIFIED.get(key) == fingerprint:
            return
        for name, record in spec['files'].items():
            digest = hashlib.sha256()
            with (directory / name).open('rb') as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                    digest.update(chunk)
            if digest.hexdigest() != record['sha256']:
                raise ValueError('Qwen model content does not match the pinned release. Open Models to repair it.')
        if _fingerprint(directory, spec) != fingerprint:
            raise ValueError('Qwen model files changed during verification. Finish file preparation, then retry.')
        if len(_VERIFIED) >= 128:
            _VERIFIED.clear()
        _VERIFIED[key] = fingerprint


_VOLUME_CHECK = '''from pathlib import Path
import hashlib,json,sys
payload=json.loads(sys.argv[1]); result={}
for folder,files in payload['checks']:
 result[folder]={}
 for name,record in files.items():
  p=Path(folder)/name
  def fingerprint():
   s=p.stat()
   if not p.is_file() or s.st_size!=record['bytes']: raise ValueError('incomplete')
   return [str(p.resolve()),s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns]
  before=fingerprint()
  if payload.get('verify_content',True) and payload['cached'].get(folder,{}).get(name)!=before:
   digest=hashlib.sha256()
   with p.open('rb') as stream:
    for chunk in iter(lambda:stream.read(1048576),b''): digest.update(chunk)
   if digest.hexdigest()!=record['sha256']: raise ValueError('checksum')
  if fingerprint()!=before: raise ValueError('changed')
  result[folder][name]=before
print(json.dumps(result))
'''


def _remove_probe(runtime, name):
    """Clean up only the exact verification container created by this call."""
    try:
        inspected = runtime.command(['container', 'inspect', name], timeout=10)
        if inspected.returncode:
            return
        records = json.loads(inspected.stdout)
        if not isinstance(records, list) or len(records) != 1:
            return
        record = records[0]
        identity = record.get('Id')
        if (record.get('Name') != '/' + name or not isinstance(identity, str)
                or not re.fullmatch(r'(?:sha256:)?[0-9a-f]{64}', identity)
                or record.get('Config', {}).get('Labels', {}).get('dev.paiton.studio.owner') != runtime.owner):
            return
        runtime.command(['rm', '--force', identity], timeout=10)
    except (RuntimeError, subprocess.TimeoutExpired, OSError, ValueError, TypeError, AttributeError):
        # A failed Docker daemon can also prevent inspection/removal. Never fall
        # back to broad cleanup or remove a container whose owner is unknown.
        return


def preflight(runtime, image, inspected, weights='mxfp4', *, verify_content=True):
    """Check readiness cheaply when requested; execution always verifies hashes."""
    reference = verify_image(inspected, image)
    selected = source_contract(runtime.config, reference, weights)
    volumes = {}
    for item in selected['components'].values():
        if 'directory' in item:
            if verify_content:
                verify_folder(item['directory'], item['spec'])
            else:
                _fingerprint(Path(item['directory']), item['spec'])
        else:
            volumes.setdefault(item['volume'], []).append((item['path'], item['spec']['files']))
    cache = getattr(runtime, '_qwen_volume_verifications', None)
    if cache is None:
        cache = {}
    for volume, checks in volumes.items():
        if runtime.command(['volume', 'inspect', volume]).returncode:
            raise ValueError('The configured Qwen cache volume is missing. Studio will not create or download one during generation.')
        key = (reference, volume, selected['manifest_sha256'])
        payload = json.dumps({'checks': checks, 'cached': cache.get(key, {}) if verify_content else {},
                              'verify_content': verify_content})
        probe_name = 'paiton-studio-qwen-check-' + uuid.uuid4().hex
        try:
            result = runtime.command(['run', '--rm', '--name', probe_name, '--pull=never', '--network', 'none', '--read-only',
                '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
                '--label', 'dev.paiton.studio.owner=' + runtime.owner, '--entrypoint', 'python3',
                '--mount', 'type=volume,src=' + volume + ',dst=/pinned-cache,readonly,volume-nocopy',
                reference, '-c', _VOLUME_CHECK, payload], timeout=1800 if verify_content else 30)
        except (RuntimeError, subprocess.TimeoutExpired) as error:
            _remove_probe(runtime, probe_name)
            raise ValueError('The Qwen checkpoint check did not finish. Retry Verify & repair in Models before creating.') from error
        try:
            fingerprints = json.loads(result.stdout)
            if result.returncode or not isinstance(fingerprints, dict) or set(fingerprints) != {folder for folder, _ in checks}:
                raise ValueError()
            if any(not isinstance(fingerprints[folder], dict) or set(fingerprints[folder]) != set(files)
                   for folder, files in checks):
                raise ValueError()
        except (ValueError, TypeError):
            raise ValueError('The Qwen cache needs the exact verified target and DFlash2 draft snapshots. Repair setup before creating.') from None
        if verify_content:
            cache[key] = fingerprints
            runtime._qwen_volume_verifications = cache
    return selected


def optional_status(runtime):
    """Cheap polling state; only a full verification can enable the weights."""
    spec = OPTIONAL_COMPONENTS['w3a4']
    configured = runtime.config.get('qwen38_w3rot_dir')
    state, complete, verified = 'not_installed', False, False
    if isinstance(configured, str) and configured:
        try:
            directory = Path(configured)
            fingerprint = _fingerprint(directory, spec)
            complete = True
            # Polling must not wait behind another checkpoint's full hash pass.
            # A busy cache is conservatively treated as not yet verified.
            if _VERIFY_LOCK.acquire(blocking=False):
                try:
                    verified = _VERIFIED.get(_verification_key(directory, spec)) == fingerprint
                finally:
                    _VERIFY_LOCK.release()
            state = 'ready' if verified else 'verification_required'
        except (OSError, ValueError):
            state = 'repair_required'
    return {'id': 'w3a4', 'label': 'Faster 3-bit weights', 'state': state,
            'installed': complete, 'verified': verified, 'download_bytes': W3_DOWNLOAD_BYTES,
            'revision': spec['revision'], 'license': spec['license'], 'license_url': spec['license_url'],
            'enabled_default': runtime.config.get(W3_DEFAULT_KEY, verified) is True,
            'quality_note': W3_NOTE}


def _runtime(manager, job, image, pull=True):
    inspected = manager.run(['docker', 'image', 'inspect', image], None)
    if inspected.returncode:
        if not pull:
            raise ValueError('Finish the Qwen3.8 base package setup before installing Faster 3-bit weights.')
        manager.update(job, 'downloading_runtime', 'Downloading the pinned conversation runtime. Existing layers are reused.', total_bytes=None)
        manager.run(['docker', 'pull', image], job)
        inspected = manager.run(['docker', 'image', 'inspect', image], job)
    verify_image(inspected.stdout, image)
    return inspected


def _download_component(manager, job, role, spec):
    directory = safe_path(manager.root, 'model-packages/qwen38-mxfp4/' + role + '/' + spec['revision'])
    for name, record in spec['files'].items():
        url = 'https://huggingface.co/' + spec['repository'] + '/resolve/' + spec['revision'] + '/' + name
        manager.download(url, safe_path(directory, name), record['bytes'], record['sha256'], job)
    verify_folder(directory, spec)
    return str(directory)


def install(manager, job, component=None):
    """Resumable CPU downloads; optional weights never replace base checkpoints."""
    if component not in (None, 'w3a4'):
        raise ValueError('Choose the supported Faster 3-bit weights component.')
    manager.check_cancel(job)
    if component:
        inspected = _runtime(manager, job, IMAGE, pull=False)
        preflight(manager.runtime, IMAGE, inspected.stdout)
        spec = OPTIONAL_COMPONENTS['w3a4']
        manager.update(job, 'downloading', 'Downloading and verifying Faster 3-bit weights.',
                       total_bytes=W3_DOWNLOAD_BYTES, completed_bytes=0)
        directory = manager.config.get('qwen38_w3rot_dir')
        try:
            if not isinstance(directory, str) or not directory:
                raise ValueError()
            verify_folder(directory, spec)
        except (OSError, ValueError):
            directory = _download_component(manager, job, 'w3a4', spec)
        updates = {'qwen38_w3rot_dir': str(Path(directory).resolve())}
        with manager.lock:
            if W3_DEFAULT_KEY not in manager.config:
                updates[W3_DEFAULT_KEY] = True
            manager.configure(updates, job)
        return
    inspected = _runtime(manager, job, IMAGE)
    try:
        preflight(manager.runtime, IMAGE, inspected.stdout)
    except (ValueError, OSError):
        ready = False
    else:
        ready = True
    planned = []
    for role, key, spec, satisfied in (
        ('target-rocm10', 'qwen38_nvfp4_target_dir', NEW_MODELS['target'], ready),
        ('draft', 'qwen38_mxfp4_draft_dir', NEW_MODELS['draft'], ready),
    ):
        if not satisfied:
            planned.append((role, key, spec))
    total = sum(record['bytes'] for _, _, spec in planned for record in spec['files'].values())
    manager.update(job, 'downloading', 'Preparing the pinned target and DFlash2 draft for both conversation modes.',
                   total_bytes=total, completed_bytes=0)
    updates = {'qwen38_mxfp4_image': IMAGE}
    for role, key, spec in planned:
        configured = manager.config.get(key)
        try:
            if not isinstance(configured, str) or not configured:
                raise ValueError()
            verify_folder(configured, spec)
            directory = str(Path(configured).resolve())
            completed = manager.job(manager._identity(job))['completed_bytes']
            manager.update(job, 'downloading', 'Reusing verified local model files.',
                           completed_bytes=completed + sum(record['bytes'] for record in spec['files'].values()))
        except (OSError, ValueError):
            directory = _download_component(manager, job, role, spec)
        updates[key] = directory
    manager.configure(updates, job)
