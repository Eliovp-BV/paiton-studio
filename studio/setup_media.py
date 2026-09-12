"""Explicit installation using pinned public packages, never an inference engine."""
import fnmatch
import hashlib
import json
import os
from pathlib import Path
import re
import time
from urllib.parse import quote

from .registry import compatibility
from .resources import gpu_lease
from .setup_catalog import CODER, FLUX, H3
from .store import safe_path
from .telemetry import gpu_status

SETUP_OWNER_LABEL = 'dev.paiton.studio.setup-owner'
SETUP_LABEL = 'dev.paiton.studio.setup-job'


def _owner(manager):
    # Reuse the installation identity with a distinct setup label, so creation
    # and setup recovery never claim one another's active containers.
    return (manager.root/'owner').read_text().strip()


def _hf_url(repository, revision, filename):
    return f'https://huggingface.co/{quote(repository, safe="/")}/resolve/{revision}/{quote(filename, safe="/")}'


def _download_snapshot(manager, job):
    metadata = manager.read_json(f"https://huggingface.co/api/models/{FLUX['repository']}/revision/{FLUX['revision']}?blobs=true", job)
    if metadata.get('sha') != FLUX['revision']:
        raise RuntimeError('The image checkpoint metadata does not match the pinned revision.')
    destination = manager.root/'model-downloads/flux'/FLUX['revision']
    chosen = [item for item in metadata.get('siblings', []) if any(fnmatch.fnmatchcase(item.get('rfilename', ''), pattern) for pattern in FLUX['patterns'])]
    required = ['model_index.json', 'text_encoder/config.json', 'text_encoder/model.safetensors', 'transformer/config.json', 'transformer/diffusion_pytorch_model.safetensors']
    if not set(required).issubset(item['rfilename'] for item in chosen):
        raise RuntimeError('The pinned image checkpoint file list is incomplete.')
    manager.update(job, 'downloading', 'Downloading the pinned image checkpoint.', total_bytes=sum((item.get('lfs') or {}).get('size', item.get('size', 0)) for item in chosen), completed_bytes=0)
    for item in chosen:
        manager.check_cancel(job)
        filename = item['rfilename']; lfs = item.get('lfs') or {}
        size = lfs.get('size', item.get('size'))
        checksum = lfs.get('sha256') or ('git:'+item['blobId'] if item.get('blobId') else None)
        if not isinstance(size, int) or size < 0 or not checksum:
            raise RuntimeError('The checkpoint source did not provide verification details for '+filename)
        manager.download(_hf_url(FLUX['repository'], FLUX['revision'], filename), safe_path(destination, filename), size, checksum, job)
    return destination


def _verify_prepared(directory, manager, job):
    manifest = json.loads((directory/'conversion.json').read_text())
    if manifest.get('source_revision') != FLUX['revision'] or manifest.get('source_model') != FLUX['repository'] or manifest.get('format_version') != 1 or not manifest.get('files'):
        raise RuntimeError('The prepared image model has an unexpected source or format.')
    for name, item in manifest['files'].items():
        manager.check_cancel(job)
        path = safe_path(directory, name)
        if path.stat().st_size != item['size_bytes']:
            raise RuntimeError('The prepared image model is incomplete: '+name)
        digest = hashlib.sha256()
        with path.open('rb') as stream:
            for chunk in iter(lambda: stream.read(16*1024**2), b''):
                manager.check_cancel(job)
                digest.update(chunk)
        if digest.hexdigest() != item['sha256']:
            raise RuntimeError('The prepared image model did not pass verification: '+name)


def _cleanup_container(manager, reference, owner, job_id):
    if not reference:
        return True
    inspected = manager.run(['docker', 'inspect', '--format', '{{json .}}', reference], None, timeout=20)
    if inspected.returncode:
        return False
    try:
        data = json.loads(inspected.stdout)
        labels = data['Config']['Labels']
        identity = data['Id']
    except (ValueError, KeyError, TypeError):
        return False
    if labels.get(SETUP_OWNER_LABEL) != owner or labels.get(SETUP_LABEL) != job_id or not re.fullmatch(r'[a-f0-9]{64}', identity):
        return False
    manager.run(['docker', 'stop', '--time', '10', identity], None, timeout=20)
    removed = manager.run(['docker', 'rm', '-f', identity], None, timeout=20)
    return removed.returncode == 0


def _prepare_flux(manager, job, source, destination):
    owner = _owner(manager)
    job_id = str(job['id'])
    lease = gpu_lease()
    manager.update(job, 'waiting_for_gpu', 'Waiting for the GPU before preparing the image model. Your other work continues.')
    while True:
        manager.check_cancel(job)
        if lease.acquire():
            status = gpu_status()
            hardware = compatibility('flux', status)
            if not hardware['compatible']:
                lease.close()
                raise RuntimeError(hardware['reason'])
            if status.get('available'):
                break
            lease.close()
            if status.get('supported') is False:
                raise RuntimeError(status['message'])
        time.sleep(.5)
    name = 'paiton-studio-prepare-'+hashlib.sha256((owner+job_id).encode()).hexdigest()[:24]
    stage = destination.parent/('.preparing-'+hashlib.sha256(job_id.encode()).hexdigest()[:20])
    cache = manager.root/'runtime-cache/setup-flux'
    reference = None
    try:
        # Every attempt gets a private output; the final cache is published only
        # after full validation, so interrupted conversion cannot look ready.
        stage.mkdir(parents=True, exist_ok=True); cache.mkdir(parents=True, exist_ok=True)
        output = stage/'runtime'
        if output.exists():
            raise RuntimeError('This preparation attempt was interrupted. Retry installation to start a new attempt; downloaded files are preserved.')
        manager.update(job, 'preparing', 'Preparing the image model locally. The GPU is reserved for this step.')
        command = ['docker', 'create', '--pull=never', '--name', name,
                   '--label', SETUP_OWNER_LABEL+'='+owner, '--label', SETUP_LABEL+'='+job_id,
                   '--network', 'none', '--log-driver', 'none', '--init',
                   '--device', '/dev/kfd', '--device', '/dev/dri',
                   '--group-add', str(os.stat('/dev/kfd').st_gid), '--shm-size', '2g',
                   '--user', f'{os.getuid()}:{os.getgid()}',
                   '--mount', f'type=bind,src={source},dst=/source,readonly',
                   '--mount', f'type=bind,src={stage},dst=/prepared',
                   '--mount', f'type=bind,src={cache},dst=/models/cache',
                   '--entrypoint', 'python3']
        for key, value in {'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1', 'HF_DATASETS_OFFLINE': '1',
                           'HF_HOME': '/models/cache/huggingface', 'HF_HUB_CACHE': '/models/cache/huggingface/hub',
                           'TORCHINDUCTOR_CACHE_DIR': '/models/cache/inductor', 'TRITON_CACHE_DIR': '/models/cache/triton',
                           'XDG_CACHE_HOME': '/models/cache/xdg'}.items():
            command += ['-e', key+'='+value]
        command += [FLUX['tools_image'], '-m', 'sdnq_tool.convert', '--snapshot', '/source', '--output', '/prepared/runtime']
        # Set the unique name first so cancellation between Docker create and
        # returning its ID still has an ownership-checked cleanup target.
        reference = name
        result = manager.run(command, job, timeout=60)
        if result.returncode:
            raise RuntimeError('The image preparation container could not be created.')
        identity = result.stdout.strip()
        if not re.fullmatch(r'[a-f0-9]{64}', identity):
            raise RuntimeError('Docker returned an invalid preparation container identity.')
        reference = identity
        result = manager.run(['docker', 'start', '-a', identity], job, timeout=3600)
        if result.returncode:
            raise RuntimeError('Image model preparation did not finish. Downloaded weights are preserved; retry when the GPU has enough memory.')
        manager.update(job, 'verifying', 'Verifying the prepared image model before connecting it to Studio.')
        _verify_prepared(output, manager, job)
        manager.check_cancel(job)
        output.rename(destination)
    finally:
        try:
            if not _cleanup_container(manager, reference, owner, job_id):
                manager._needs_recovery = True
        finally:
            lease.close()
        # Remove only an empty stage, retaining interrupted outputs for recovery
        # or an explicit later cache cleanup.
        try: stage.rmdir()
        except OSError: pass


def _install_flux(manager, job):
    manager.update(job, 'downloading_runtime', 'Downloading the pinned image runtime and preparation tool.', total_bytes=None)
    manager.run(['docker', 'pull', FLUX['image']], job, timeout=7200)
    manager.run(['docker', 'pull', FLUX['tools_image']], job, timeout=7200)
    manager.update(job, 'downloading', 'Downloading and checking the exact image model files.')
    source = _download_snapshot(manager, job)
    destination = manager.root/'model-packages/flux'/FLUX['revision']
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        manager.update(job, 'verifying', 'Checking the image model already prepared by Studio.')
        _verify_prepared(destination, manager, job)
    else:
        _prepare_flux(manager, job, source, destination)
    manager.configure({'flux_image': FLUX['image'], 'flux_model_dir': str(destination)}, job)


def _install_h3(manager, job):
    manager.update(job, 'downloading_runtime', 'Downloading the pinned video package and its public assembly recipe.', total_bytes=None)
    manager.run(['docker', 'pull', H3['base_image']], job, timeout=7200)
    package = manager.root/'model-packages/h3'/H3['source_revision']
    source_base = f"https://raw.githubusercontent.com/{H3['source_repository']}/{H3['source_revision']}/{H3['source_subdir']}"
    for item in H3['source_files']:
        manager.download(source_base+'/'+item['file'], safe_path(package, item['file']), item['bytes'], item['sha256'], job)
    image = 'paiton-studio-h3:'+hashlib.sha256(str(manager.root).encode()).hexdigest()[:12]+'-'+H3['source_revision'][:12]
    manager.update(job, 'preparing', 'Assembling the video runtime locally from its pinned public packages. This step uses the CPU.')
    result = manager.run(['docker', 'build', '--provenance=false', '--build-arg', 'PAITON_H3_BASE_IMAGE='+H3['base_image'],
                         '--label', 'dev.paiton.distribution=local-assembly-only', '-t', image,
                         '-f', str(package/'Dockerfile.local'), str(package)], job, timeout=7200)
    if result.returncode:
        raise RuntimeError('The local video package did not finish building. Downloaded files are preserved for retry.')
    manager.update(job, 'downloading', 'Downloading and verifying the video model, soundtrack model and both supported presets.')
    models = package/'models'
    manager.update(job, 'downloading', 'Downloading the pinned video checkpoint files.', total_bytes=sum(item['bytes'] for item in H3['files']), completed_bytes=0)
    for item in H3['files']:
        manager.download(_hf_url(item['repository'], item['revision'], item['file']), safe_path(models, item['destination']), item['bytes'], item['sha256'], job)
    manager.update(job, 'verifying', 'Checking that the installed video package accepts your exact input image.')
    # Inspect source syntax with no GPU device and no model imports. A passing
    # check establishes the interface, not a hardware generation claim.
    script = "import ast; from pathlib import Path; t=ast.parse(Path('/opt/comfyui/comfy_extras/nodes_minimax_h3.py').read_text()); c=next(n for n in t.body if isinstance(n,ast.ClassDef) and n.name=='MiniMaxH3ImageToVideo'); f=next(n for n in c.body if isinstance(n,ast.FunctionDef) and n.name=='execute'); assert 'first_frame' in [a.arg for a in f.args.args]"
    owner = _owner(manager)
    name = 'paiton-studio-verify-'+hashlib.sha256((owner+str(job['id'])).encode()).hexdigest()[:24]
    try:
        result = manager.run(['docker', 'run', '--rm', '--pull=never', '--name', name,
                              '--label', SETUP_OWNER_LABEL+'='+owner, '--label', SETUP_LABEL+'='+str(job['id']),
                              '--network', 'none', '--read-only', '--entrypoint', 'python3', image, '-c', script], job, timeout=60)
        if result.returncode:
            raise RuntimeError('The installed video package does not expose the verified image input. Studio will not substitute text-to-video.')
    finally:
        _cleanup_container(manager, name, owner, str(job['id']))
    manager.configure({'h3_image': image, 'h3_models_dir': str(models), 'h3_package_dir': str(package)}, job)


def _install_coder(manager, job):
    manager.update(job, 'downloading_runtime', 'Downloading the pinned alternative writing runtime.', total_bytes=None)
    manager.run(['docker', 'pull', CODER['image']], job, timeout=7200)
    metadata = manager.read_json(f"https://huggingface.co/api/models/{CODER['repository']}/revision/{CODER['revision']}?blobs=true", job)
    if metadata.get('sha') != CODER['revision']:
        raise RuntimeError('The writing checkpoint metadata does not match the pinned revision.')
    files = metadata.get('siblings', [])
    names = {item.get('rfilename') for item in files if isinstance(item, dict)}
    if not {'config.json', 'tokenizer_config.json', 'tokenizer.json'}.issubset(names) or not any(isinstance(name, str) and name.endswith('.safetensors') for name in names):
        raise RuntimeError('The pinned writing checkpoint file list is incomplete.')
    total = sum((item.get('lfs') or {}).get('size', item.get('size', 0)) for item in files)
    manager.update(job, 'downloading', 'Downloading and verifying the alternative writing model.', total_bytes=total, completed_bytes=0)
    hub = manager.root/'model-packages/qwen-coder/hub'
    snapshot = hub/CODER['cache_repository']/'snapshots'/CODER['revision']
    for item in files:
        manager.check_cancel(job)
        filename = item['rfilename']; lfs = item.get('lfs') or {}
        size = lfs.get('size', item.get('size'))
        checksum = lfs.get('sha256') or ('git:'+item['blobId'] if item.get('blobId') else None)
        if not isinstance(size, int) or size < 0 or not checksum:
            raise RuntimeError('The checkpoint source did not provide verification details for '+filename)
        manager.download(_hf_url(CODER['repository'], CODER['revision'], filename), safe_path(snapshot, filename), size, checksum, job)
    # snapshot_download(local_files_only=True, revision=<commit>) reuses this
    # complete layout without refs or a mutable shared host cache.
    manager.configure({'writing_image': CODER['image'], 'writing_hub_dir': str(hub)}, job)


def recover_setup(manager):
    """Return success only after checking and cleaning this setup owner's list."""
    owner = _owner(manager)
    result = manager.run(['docker', 'ps', '--all', '--quiet', '--no-trunc', '--filter', 'label='+SETUP_OWNER_LABEL+'='+owner], None, timeout=30)
    if result.returncode:
        return False
    successful = True
    for identity in result.stdout.split():
        if not re.fullmatch(r'[a-f0-9]{64}', identity):
            successful = False
            continue
        inspected = manager.run(['docker', 'inspect', '--format', '{{json .}}', identity], None, timeout=20)
        if inspected.returncode:
            successful = False
            continue
        try:
            labels = json.loads(inspected.stdout)['Config']['Labels']
            job_id = labels[SETUP_LABEL]
        except (ValueError, KeyError, TypeError):
            successful = False
            continue
        if labels.get(SETUP_OWNER_LABEL) == owner:
            successful = _cleanup_container(manager, identity, owner, job_id) and successful
    return successful


def install_media(manager, job):
    if job['package'] == 'flux':
        _install_flux(manager, job)
    elif job['package'] == 'h3':
        _install_h3(manager, job)
    elif job['package'] == 'qwen-coder':
        _install_coder(manager, job)
    else:
        raise ValueError('Choose a supported media package.')
