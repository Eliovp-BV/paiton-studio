"""Read a saved request inside the owned container and save its PNG atomically."""
import base64
import json
import os
import re
from pathlib import Path
import urllib.request


def decode_response(content, selected):
    """Keep image bytes and a small public quality receipt, never runtime internals."""
    if len(content) > 40 * 1024**2:
        raise ValueError('The image response exceeds the supported size.')
    result = json.loads(content)
    if not isinstance(result, dict) or not isinstance(result.get('data'), list) or len(result['data']) != 1:
        raise ValueError('The runtime must return exactly one image.')
    item = result['data'][0]
    if not isinstance(item, dict) or not isinstance(item.get('b64_json'), str):
        raise ValueError('The runtime did not return an encoded PNG image.')
    png = base64.b64decode(item['b64_json'], validate=True)
    if not png.startswith(b'\x89PNG\r\n\x1a\n'):
        raise ValueError('The runtime did not return a PNG image.')
    metrics = result.get('metrics', {})
    if not isinstance(metrics, dict):
        raise ValueError('The image quality receipt is invalid.')
    receipt = {}
    precision = metrics.get('precision_profile')
    if isinstance(precision, str) and re.fullmatch(r'[a-z0-9-]{1,32}', precision):
        receipt['precision_profile'] = precision
    checkpoint = metrics.get('checkpoint_sha256')
    if isinstance(checkpoint, str) and re.fullmatch(r'[a-f0-9]{64}', checkpoint):
        receipt['checkpoint_sha256'] = checkpoint
    if metrics.get('model') in ('paiton-image-2.1', 'paiton-image-2.1-uncensored'):
        receipt['model'] = metrics['model']
    if metrics.get('model_variant') in ('original', 'uncensored'):
        receipt['model_variant'] = metrics['model_variant']
    settings = metrics.get('settings')
    if 'settings' in metrics and not isinstance(settings, dict):
        raise ValueError('The image quality settings are invalid.')
    if isinstance(settings, dict):
        receipt['settings'] = {key: settings[key] for key in (
            'width', 'height', 'output_resolution', 'num_inference_steps', 'true_cfg_scale', 'use_kv_cache')
            if key in settings and type(settings[key]) in (int, float, bool)}
    return png, receipt


def main():
    directory = Path('/job')
    request = json.loads((directory / 'request.json').read_text())
    selected = request['profile']
    model = 'paiton-image-2.1-uncensored' if selected.get('package') == 'qwen-image21-uncensored' else 'paiton-image-2.1'
    body = dict(model=model, prompt=request['prompt'], seed=request['seed'],
                size=f"{selected['width']}x{selected['height']}", mode=selected['mode'],
                n=1, steps=selected['steps'], guidance=selected['guidance'], response_format='b64_json')
    endpoint = 'generations'
    if selected['mode'] == 'edit':
        endpoint = 'edits'
        # The host validates identity, size and checksum, then prepares this
        # fixed PNG copy. Saved request paths never become container inputs.
        path = directory / 'source.png'
        if path.is_symlink() or path.stat().st_size > 24 * 1024**2:
            raise ValueError('The prepared edit input is invalid or too large.')
        with path.open('rb') as stream:
            png = stream.read(24 * 1024**2 + 1)
        if len(png) > 24 * 1024**2 or not png.startswith(b'\x89PNG\r\n\x1a\n'):
            raise ValueError('The prepared edit input must be a bounded PNG.')
        body['image_b64'] = base64.b64encode(png).decode('ascii')
    content = json.dumps(body).encode()
    if len(content) > 32 * 1024**2:
        raise ValueError('The image request exceeds 32 MiB.')
    call = urllib.request.Request('http://127.0.0.1:8191/v1/images/' + endpoint,
        data=content, headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(call, timeout=1700) as response:
        content = response.read(40 * 1024**2 + 1)
    png, receipt = decode_response(content, selected)
    (directory / 'result-metadata.json.part').write_text(json.dumps(receipt))
    os.replace(directory / 'result-metadata.json.part', directory / 'result-metadata.json')
    (directory / 'result.png.part').write_bytes(png)
    os.replace(directory / 'result.png.part', directory / 'result.png')
    print('STUDIO:' + json.dumps(dict(state='saving', message='Saving your image.')), flush=True)


if __name__ == '__main__':
    main()
