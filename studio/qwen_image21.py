"""Bounded image API adapter; inference stays in the distributed runtime."""
import hashlib
import io
import json
import re
from pathlib import Path
from urllib.parse import quote

from .store import safe_path

CHECKPOINT = json.loads((Path(__file__).parent / 'contracts/qwen-image21-checkpoint.json').read_text())
REVISION = CHECKPOINT['revision']
UNCENSORED_CHECKPOINT = json.loads((Path(__file__).parent / 'contracts/qwen-image21-uncensored-checkpoint.json').read_text())
UNCENSORED_REVISION = UNCENSORED_CHECKPOINT['revision']
IMAGE = 'ghcr.io/eliovp/paiton-vllm-plugin@sha256:64f6a6154b93f39b34f272fc66110ce17f72cca3ec31284ab57056ca5cdc2677'
RUNTIME_IMAGES = [
    dict(reference=IMAGE, label='1.0.3 · original, uncensored & editing', channel='stable',
         precision_profile='exact', model_selection=True, image_edit=True),
    dict(reference='ghcr.io/eliovp/paiton-vllm-plugin@sha256:c7ab0c5f900bf16c2b56fa5aa0f9dd7b8c32a0ea6106db954b43556c4cc07d97',
         label='1.0.2 · previous release · exact quality', channel='previous', precision_profile='exact'),
    dict(reference='ghcr.io/eliovp/paiton-vllm-plugin@sha256:979649b74dc94a76bc9f0fe5b7c6280be0c060148a3dba85426630263c9a448e',
         label='1.0.1 · previous release', channel='previous'),
    dict(reference='paiton-qwen-image21:attention-review-20260922',
         image_id='sha256:eae67793a897c971f6f2a23ef40d9903b4d1fc3a4737bbd5391b726033df22d0',
         label='Local candidate · pending publication', channel='candidate'),
]
CHECKPOINT_SHA256 = next(item['sha256'] for item in CHECKPOINT['files'] if item['file'] == 'result.json')
UNCENSORED_CHECKPOINT_SHA256 = next(item['sha256'] for item in UNCENSORED_CHECKPOINT['files'] if item['file'] == 'result.json')
MAX_EDIT_PIXELS = 4_194_304
MAX_SOURCE_BYTES = 32 * 1024**2


def model_contract(selected=None):
    selected = selected or {}
    package = selected.get('package', 'qwen-image21')
    if package not in ('qwen-image21', 'qwen-image21-uncensored'):
        raise ValueError('Choose a supported Qwen image model.')
    uncensored = package == 'qwen-image21-uncensored'
    variant = 'uncensored' if uncensored else 'original'
    if selected.get('checkpoint_variant', variant) != variant:
        raise ValueError('The Qwen checkpoint does not match the saved profile.')
    prefix = 'qwen_image21_uncensored' if uncensored else 'qwen_image21'
    return dict(package=package, variant=variant,
                api_id='paiton-image-2.1-uncensored' if uncensored else 'paiton-image-2.1',
                checkpoint=UNCENSORED_CHECKPOINT if uncensored else CHECKPOINT,
                revision=UNCENSORED_REVISION if uncensored else REVISION,
                checkpoint_sha256=UNCENSORED_CHECKPOINT_SHA256 if uncensored else CHECKPOINT_SHA256,
                image_key=prefix + '_image', model_dir_key=prefix + '_model_dir')


def validate_release(selected, release):
    if model_contract(selected)['variant'] == 'uncensored' and not release.get('model_selection'):
        raise ValueError('The uncensored checkpoint needs Qwen image runtime 1.0.3. Select it in Settings → Runtime packages.')
    if selected.get('mode') == 'edit' and not release.get('image_edit'):
        raise ValueError('Image editing needs Qwen image runtime 1.0.3. Select it in Settings → Runtime packages.')


def validate_request(request):
    selected = request['profile']
    contract = model_contract(selected)
    if selected.get('mode') not in ('text-to-image', 'rgba', 'edit'):
        raise ValueError('Choose a supported Qwen image creation profile.')
    if (type(selected.get('width')) is not int or type(selected.get('height')) is not int
            or selected['width'] != selected['height'] or selected['width'] not in (1024, 2048)
            or type(selected.get('steps')) is not int or selected['steps'] != 40
            or type(selected.get('guidance')) not in (int, float) or selected['guidance'] != 1.0
            or type(selected.get('batch')) is not int or selected['batch'] != 1):
        raise ValueError('Qwen image creation requires a 1024 or 2048 square image, 40 steps, guidance 1.0 and one image.')
    prompt = request.get('prompt')
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 512:
        raise ValueError('Qwen-Image-2.1 needs a prompt of 1 to 512 characters.')
    seed = request.get('seed')
    if type(seed) is not int or not 0 <= seed <= 2**53 - 1:
        raise ValueError('Choose a whole-number seed from 0 to 9007199254740991.')
    if selected['mode'] == 'edit':
        if selected['width'] != 1024:
            raise ValueError('Qwen image editing saves a 1024 × 1024 image.')
        if not isinstance(request.get('source'), dict) or not request['source'].get('id'):
            raise ValueError('Choose an original image from this project to edit.')
    elif request.get('source'):
        raise ValueError('This Qwen profile creates a new image; it does not accept an input image.')
    return dict(model=contract['api_id'], prompt=prompt, seed=seed,
                size=f"{selected['width']}x{selected['height']}", mode=selected['mode'],
                n=1, steps=selected['steps'], guidance=selected['guidance'], response_format='b64_json')


def validate_source(store, request, project=None):
    """Resolve the saved original again; normalize only a bounded, verified copy."""
    from PIL import Image, ImageOps
    source = request.get('source')
    if not isinstance(source, dict) or not source.get('id'):
        raise ValueError('Choose an original image from this project to edit.')
    project = project or source.get('project')
    if not project or source.get('project') != project:
        raise ValueError('Choose an original image from this project to edit.')
    asset = store.asset(source['id'], project)
    if (asset['kind'] != 'image' or asset['path'] != source.get('path')
            or asset['metadata'].get('sha256') != source.get('sha256')
            or not re.fullmatch(rf'projects/{re.escape(project)}/assets/{re.escape(asset["id"])}\.(png|jpg|jpeg)', asset['path'])):
        raise ValueError('The original image changed. Choose it again from this project.')
    path = store.file(asset)
    if not path.is_file() or path.stat().st_size > MAX_SOURCE_BYTES:
        raise ValueError('The original image is missing or exceeds 32 MiB. Import it again.')
    with path.open('rb') as stream:
        content = stream.read(MAX_SOURCE_BYTES + 1)
    if len(content) > MAX_SOURCE_BYTES or hashlib.sha256(content).hexdigest() != source['sha256']:
        raise ValueError('The original image changed on disk. Import it again before editing.')
    try:
        with Image.open(io.BytesIO(content)) as image:
            if image.format not in ('PNG', 'JPEG'):
                raise ValueError('Choose a complete PNG or JPEG image to edit.')
            if image.width * image.height > MAX_EDIT_PIXELS:
                raise ValueError('Choose an edit input with at most 4,194,304 pixels. The original is not resized.')
            image.verify()
        with Image.open(io.BytesIO(content)) as image:
            normalized = ImageOps.exif_transpose(image).convert('RGBA')
            prepared = io.BytesIO()
            normalized.save(prepared, format='PNG')
            metadata = dict(source_id=asset['id'], source_sha256=source['sha256'],
                            source_width=normalized.width, source_height=normalized.height,
                            source_preparation='PNG copy; EXIF orientation; original preserved')
    except (OSError, Image.DecompressionBombError) as error:
        raise ValueError('Choose a complete PNG or JPEG image within the edit size limit.') from error
    png = prepared.getvalue()
    if 4 * ((len(png) + 2) // 3) + 16384 > 32 * 1024**2:
        raise ValueError('The original image exceeds the editing request size limit.')
    return png, metadata


def image_contract(inspected):
    data = json.loads(inspected) if isinstance(inspected, str) else inspected
    data = data[0] if isinstance(data, list) and len(data) == 1 else data
    if not isinstance(data, dict) or not isinstance(data.get('Id'), str) or not re.fullmatch(r'sha256:[a-f0-9]{64}', data['Id']):
        raise ValueError('The Qwen image package could not be identified.')
    for contract in RUNTIME_IMAGES:
        if contract.get('image_id') and data.get('Id') == contract['image_id']:
            return data, contract
        if '@sha256:' in contract['reference'] and (contract['reference'] in (data.get('RepoDigests') or [])
                or data.get('Id') == contract['reference'].split('@', 1)[1]):
            return data, contract
    raise ValueError('This runtime is not a reviewed Qwen-Image-2.1 package. Select a compatible version in Settings.')


def validate_image(inspected):
    data, _ = image_contract(inspected)
    return data['Id']


def result_receipt(directory, selected, release):
    """Require evidence of the requested arithmetic from releases that support it."""
    expected = release.get('precision_profile')
    contract = model_contract(selected)
    path = directory / 'result-metadata.json'
    if not path.is_file():
        if expected:
            raise ValueError('The Qwen runtime did not confirm the requested exact quality settings.')
        return {}
    if path.stat().st_size > 16 * 1024:
        raise ValueError('The Qwen image quality receipt is invalid.')
    receipt = json.loads(path.read_text())
    if not isinstance(receipt, dict):
        raise ValueError('The Qwen image quality receipt is invalid.')
    if expected:
        settings = dict(width=selected['width'], height=selected['height'], output_resolution=selected['width'],
                        num_inference_steps=selected['steps'], true_cfg_scale=selected['guidance'], use_kv_cache=True)
        actual = receipt.get('settings')
        if (receipt.get('precision_profile') != expected or receipt.get('checkpoint_sha256') != contract['checkpoint_sha256']
                or actual != settings
                or any(type(actual[key]) is not int for key in ('width', 'height', 'output_resolution', 'num_inference_steps'))
                or type(actual['true_cfg_scale']) not in (int, float) or actual['use_kv_cache'] is not True):
            raise ValueError('The Qwen runtime did not use the requested exact quality settings. Its output was not saved.')
    if release.get('model_selection') and (receipt.get('model') != contract['api_id']
            or receipt.get('model_variant') != contract['variant']):
        raise ValueError('The Qwen runtime did not confirm the selected model. Its output was not saved.')
    # The container helper already filters metrics; only these public settings
    # can become asset metadata, even if an older runtime returns more fields.
    result = {}
    for key, pattern in (('precision_profile', r'[a-z0-9-]{1,32}'), ('checkpoint_sha256', r'[a-f0-9]{64}')):
        if isinstance(receipt.get(key), str) and re.fullmatch(pattern, receipt[key]):
            result[key] = receipt[key]
    if receipt.get('model') == contract['api_id']:
        result['model'] = contract['api_id']
    if receipt.get('model_variant') == contract['variant']:
        result['model_variant'] = contract['variant']
    if isinstance(receipt.get('settings'), dict):
        result['settings'] = {key: value for key, value in receipt['settings'].items()
            if key in ('width', 'height', 'output_resolution', 'num_inference_steps', 'true_cfg_scale', 'use_kv_cache')
            and type(value) in (int, float, bool)}
    return result


def checkpoint_layout(directory, selected=None):
    """Mount an existing pinned HF snapshot with its relative blob targets intact."""
    directory = Path(directory).resolve()
    revision = model_contract(selected)['revision']
    if directory.parent.name == 'snapshots':
        repository = directory.parent.parent
        blobs = repository / 'blobs'
        if directory.name != revision or blobs.is_symlink() or not blobs.is_dir():
            raise ValueError('Choose the pinned Qwen image checkpoint or its complete local cache snapshot.')
        return repository, '/checkpoint-cache', '/checkpoint-cache/snapshots/' + revision
    return directory, '/checkpoint', '/checkpoint'


def preflight(runtime, inspected, selected=None):
    selected = selected or {}
    _, release = image_contract(inspected)
    validate_release(selected, release)
    contract = model_contract(selected)
    directory = Path(runtime.config_path(contract['model_dir_key'])).resolve()
    mount, container_root, _ = checkpoint_layout(directory, selected)
    for item in contract['checkpoint']['files']:
        if container_root == '/checkpoint-cache':
            candidate = directory / item['file']
            # Snapshot links may reach this repository's immutable blobs only.
            # Parent directories cannot redirect individual files elsewhere.
            if not candidate.parent.resolve().is_relative_to(directory):
                raise ValueError('The Qwen image cache contains an invalid checkpoint link.')
            if candidate.is_symlink():
                link = candidate.readlink()
                if link.is_absolute() or (candidate.parent / link).is_symlink():
                    raise ValueError('The Qwen image cache needs relative links to regular blob files.')
            path = candidate.resolve()
            allowed = mount / 'blobs' if candidate.is_symlink() else directory
            if not path.is_relative_to(allowed):
                raise ValueError('The Qwen image cache contains an invalid checkpoint link.')
        else:
            path = safe_path(directory, item['file'])
        if not path.is_file() or path.stat().st_size != item['bytes']:
            raise ValueError('Qwen image weights are missing or incomplete. Open Tool setup & downloads to repair them.')
        # Large tensors are checksum-verified by setup and again by the package
        # launcher. Small index/config files are also checked on readiness probes.
        if item['bytes'] < 1_000_000 and hashlib.sha256(path.read_bytes()).hexdigest() != item['sha256']:
            raise ValueError('Qwen image checkpoint metadata does not match the selected release. Repair its download.')


def install(manager, job):
    contract = model_contract({'package': job['package']})
    checkpoint, revision = contract['checkpoint'], contract['revision']
    selected_image = manager.config.get(contract['image_key']) or IMAGE
    inspected = manager.runtime.command(['image', 'inspect', selected_image])
    if inspected.returncode:
        if selected_image != IMAGE:
            raise ValueError('The selected Qwen image package is missing. Select or download its version in Runtime packages first.')
        manager.update(job, 'downloading_runtime', 'Downloading the pinned Qwen image runtime.', total_bytes=None)
        manager.run(['docker', 'pull', IMAGE], job, timeout=7200)
        inspected = manager.runtime.command(['image', 'inspect', IMAGE])
    if inspected.returncode:
        raise RuntimeError('The downloaded Qwen image runtime could not be verified.')
    _, release = image_contract(inspected.stdout)
    validate_release({'package': contract['package']}, release)
    directory = manager.root / 'model-packages' / contract['package'] / revision
    manager.update(job, 'downloading', 'Downloading and verifying the Qwen image checkpoint.',
                   total_bytes=checkpoint['download_bytes'], completed_bytes=0)
    base = f"https://huggingface.co/{checkpoint['repository']}/resolve/{revision}/"
    for item in checkpoint['files']:
        manager.check_cancel(job)
        manager.download(base + quote(item['file'], safe='/'), safe_path(directory, item['file']),
                         item['bytes'], item['sha256'], job)
    manager.configure({contract['image_key']: selected_image, contract['model_dir_key']: str(directory)}, job)


def run(runtime, job, image, directory):
    from PIL import Image
    from .media import image_info
    from .runtime import RuntimeFailure
    request = job['request']
    validate_request(request)
    selected = request['profile']
    contract = model_contract(selected)
    source_metadata = {}
    if selected['mode'] == 'edit':
        from .store import atomic
        png, source_metadata = validate_source(runtime.store, request, project=job['project'])
        atomic(directory / 'source.png', png)
    container = None
    try:
        inspected = runtime.command(['image', 'inspect', image])
        if inspected.returncode:
            raise RuntimeFailure('The selected Qwen image package is no longer available.')
        _, release = image_contract(inspected.stdout)
        validate_release(selected, release)
        mount, container_root, model_path = checkpoint_layout(runtime.config_path(contract['model_dir_key']), selected)
        launch = ['--model-dir', model_path, '--offline', 'serve', '--host', '127.0.0.1', '--port', '8191']
        if release.get('model_selection'):
            launch = ['--model', contract['variant'], *launch]
        if release.get('precision_profile'):
            # v1.0.2 defaults to a faster mixed-precision schedule. Studio's
            # quality profiles explicitly retain exact arithmetic; legacy
            # packages do not recognize this CLI option.
            launch += ['--precision-profile', release['precision_profile']]
        container, _ = runtime.start(job, image,
            launch,
            mounts=[(str(mount), container_root)],
            env={'PAITON_GPU_LOCK': '/models/cache/image-gpu.lock',
                 'MIOPEN_USER_DB_PATH': '/models/cache/miopen-db',
                 'MIOPEN_CUSTOM_CACHE_DIR': '/models/cache/miopen-kernels'})
        runtime.check_cancel(job)
        started = runtime.command(['start', container])
        if started.returncode:
            raise RuntimeFailure('The Qwen image container could not start.')
        health = runtime.wait_ready(job, container, 8191, '/health')
        if release.get('model_selection') and (not isinstance(health, dict)
                or health.get('model') != contract['api_id'] or health.get('model_variant') != contract['variant']
                or health.get('checkpoint_sha256') != contract['checkpoint_sha256']):
            raise RuntimeFailure('The Qwen runtime loaded a different checkpoint than the saved request.')
        models = runtime.http(container, 8191, '/v1/models')
        model = next((m for m in models.get('data', []) if m.get('id') == contract['api_id']), {})
        sizes = model.get({'rgba': 'rgba_sizes', 'edit': 'edit_sizes'}.get(selected['mode'], 'generation_sizes'), [])
        if (f"{selected['width']}x{selected['height']}" not in sizes or model.get('steps') != 40
                or model.get('guidance') != 1.0 or model.get('batch_size') != 1):
            raise RuntimeFailure('The Qwen runtime does not support the saved image profile.')
        message = 'Editing a copy of your image.' if selected['mode'] == 'edit' else 'Creating your image.'
        runtime.store.status(job['id'], 'generating', message + ' This package reports completion when the image is ready.')
        runtime.stream(job, ['exec', container, 'python3', '/studio/qwen_image21_job.py'], limit=1800)
        try:
            receipt = result_receipt(directory, selected, release)
        except (ValueError, OSError) as error:
            raise RuntimeFailure(str(error)) from error
        result = directory / 'result.png'
        info = image_info(result.read_bytes())
        if (info['width'], info['height'], info['format']) != (selected['width'], selected['height'], 'PNG'):
            raise RuntimeFailure('The Qwen output does not match the saved resolution and format.')
        with Image.open(result) as output:
            if selected['mode'] == 'rgba' and output.mode != 'RGBA':
                raise RuntimeFailure('The Qwen output is missing the requested alpha channel.')
            info['has_alpha'] = output.mode == 'RGBA'
        info['runtime_image'] = image
        info['operation'] = selected['mode']
        info.update(source_metadata)
        info.update(receipt)
        return 'image', result, info
    finally:
        if container:
            try:
                from .store import atomic
                logs = runtime.command(['logs', '--tail', '100', container])
                atomic(directory / 'runtime-container.log', (logs.stdout + logs.stderr).encode())
            except Exception:
                pass  # Diagnostic failure must not prevent owned-container cleanup.
            runtime.stop(container)
