"""Studio integration for the published MXFP4 target + DFlash2 runtime.

Only public release contracts live here. The shipped container verifies every
checkpoint SHA256 before starting ordinary local vLLM; Studio owns its lifecycle.
"""
import hashlib
import json
from pathlib import Path
import re
import time

from .store import safe_path

IMAGE_ID = 'sha256:9b2dae214076d35de785e073b31294b033a376b16e6bc1ec1fdada4e54d96c59'
IMAGE = 'ghcr.io/eliovp/paiton-vllm-plugin@' + IMAGE_ID
SOURCE_REVISION = '8b67db025a2d027fe577d9d4746f4f669e8ffb02'
MODELS = json.loads((Path(__file__).parent / 'contracts/qwen38-mxfp4-checkpoints.json').read_text())['models']
REVISION = MODELS['target']['revision']
DOWNLOAD_BYTES = sum(file['bytes'] for model in MODELS.values() for file in model['files'].values())


def sources(config):
    """Explicit snapshots win; a Docker cache is mounted read-only as a source."""
    paths = [config.get('qwen38_mxfp4_' + role + '_dir') for role in MODELS]
    if any(paths):
        if not all(isinstance(path, str) and path and Path(path).is_dir() for path in paths):
            raise ValueError('Qwen MXFP4 needs both the pinned target and DFlash2 draft folders. Open Creation tools to finish setup.')
        mounts = [(str(Path(path).resolve()), '/models/' + role) for role, path in zip(MODELS, paths)]
        arguments = ['--offline', '--target', '/models/target', '--draft', '/models/draft']
        return mounts, arguments
    volume = config.get('qwen38_mxfp4_cache_volume')
    if not isinstance(volume, str) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]*', volume):
        raise ValueError('Set up Qwen MXFP4 target and draft weights in Creation tools, or connect its existing local cache volume.')
    arguments = ['--offline']
    for role, spec in MODELS.items():
        arguments += ['--' + role, '/pinned-cache/hub/models--' + spec['repository'].replace('/', '--') + '/snapshots/' + spec['revision']]
    return [(volume, '/pinned-cache')], arguments


def verify_image(inspected):
    image = json.loads(inspected)[0]
    # Containerd-backed Docker reports the index digest as Id; classic Docker
    # can report the config digest instead. The immutable RepoDigest pins both.
    if image.get('Id') != IMAGE_ID and IMAGE not in image.get('RepoDigests', []):
        raise ValueError('Install the pinned Qwen3.8 MXFP4 + DFlash2 runtime. Qronos and other Qwen images cannot serve this profile.')


def verify_folder(directory, spec):
    # The container rehashes the complete weights on load. Keep the repeated
    # settings/queue preflight bounded; verify small configuration files here.
    for name, record in spec['files'].items():
        path = directory / name
        if not path.is_file() or path.stat().st_size != record['bytes']:
            raise ValueError('Qwen MXFP4 target or DFlash2 draft files are missing or incomplete. Open Creation tools to download or repair them.')
        if record['bytes'] <= 1024**2 and hashlib.sha256(path.read_bytes()).hexdigest() != record['sha256']:
            raise ValueError('Qwen MXFP4 configuration does not match the pinned target and draft release.')


def preflight(runtime, image, inspected):
    verify_image(inspected)
    mounts, arguments = sources(runtime.config)
    if len(mounts) == 2:
        for (path, _), spec in zip(mounts, MODELS.values()):
            verify_folder(Path(path), spec)
        return
    volume = mounts[0][0]
    if runtime.command(['volume', 'inspect', volume]).returncode:
        raise ValueError('The configured Qwen MXFP4 cache volume is missing. Studio will not create or download one during generation.')
    key = ('qwen38-mxfp4', IMAGE_ID, volume)
    if time.monotonic() - runtime._source_checks.get(key, float('-inf')) < 30:
        return
    # No GPU or network access, no cache ownership changes, and no volume copy-up.
    checks = [(arguments[arguments.index('--' + role) + 1], spec['files']) for role, spec in MODELS.items()]
    script = 'from pathlib import Path; import hashlib,json,sys\n'
    script += 'checks=json.loads(sys.argv[1])\n'
    script += 'for folder,files in checks:\n'
    script += ' for name,record in files.items():\n'
    script += '  p=Path(folder)/name\n'
    script += "  if not p.is_file() or p.stat().st_size!=record['bytes']: sys.exit(2)\n"
    script += "  if record['bytes']<=1048576 and hashlib.sha256(p.read_bytes()).hexdigest()!=record['sha256']: sys.exit(3)\n"
    result = runtime.command(['run', '--rm', '--pull=never', '--network', 'none', '--read-only',
        '--label', 'dev.paiton.studio.owner=' + runtime.owner, '--entrypoint', 'python3',
        '--mount', 'type=volume,src=' + volume + ',dst=/pinned-cache,readonly,volume-nocopy',
        image, '-c', script, json.dumps(checks)])
    if result.returncode:
        raise ValueError('The Qwen MXFP4 cache needs both exact target and DFlash2 draft snapshots. Finish their download before creating.')
    runtime._source_checks[key] = time.monotonic()


def install(manager, job):
    """CPU-only, resumable downloads; no server or GPU is started by setup."""
    inspected = manager.run(['docker', 'image', 'inspect', IMAGE], None)
    if inspected.returncode:
        manager.update(job, 'downloading_runtime', 'Downloading the pinned Qwen MXFP4 runtime. Existing Docker layers are reused.', total_bytes=None)
        manager.run(['docker', 'pull', IMAGE], job)
        inspected = manager.run(['docker', 'image', 'inspect', IMAGE], job)
    verify_image(inspected.stdout)
    manager.update(job, 'downloading', 'Downloading and verifying the Qwen target and its DFlash2 draft model.',
                   total_bytes=DOWNLOAD_BYTES, completed_bytes=0)
    updates = {'qwen38_mxfp4_image': IMAGE}
    for role, spec in MODELS.items():
        directory = safe_path(manager.root, 'model-packages/qwen38-mxfp4/' + role + '/' + spec['revision'])
        for name, record in spec['files'].items():
            url = 'https://huggingface.co/' + spec['repository'] + '/resolve/' + spec['revision'] + '/' + name
            manager.download(url, safe_path(directory, name), record['bytes'], record['sha256'], job)
        updates['qwen38_mxfp4_' + role + '_dir'] = str(directory)
    # Configuration is registered only after all eight exact hashes pass.
    manager.configure(updates, job)
