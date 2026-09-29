"""Exercise the in-container image response boundary without starting a runtime."""
import base64
import importlib.util
import io
import json
from pathlib import Path

import pytest
from PIL import Image


@pytest.fixture
def helper():
    path = Path(__file__).parents[1] / 'scripts' / 'qwen_image21_job.py'
    spec = importlib.util.spec_from_file_location('qwen_image21_job_test', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def selected():
    return dict(width=2048, height=2048, steps=40, guidance=1.0, mode='rgba')


@pytest.fixture
def response(selected):
    image = io.BytesIO()
    Image.new('RGBA', (selected['width'], selected['height']), (20, 100, 210, 120)).save(image, format='PNG')
    return dict(data=[dict(b64_json=base64.b64encode(image.getvalue()).decode())],
                metrics=dict(precision_profile='exact', checkpoint_sha256='a' * 64,
                             settings=dict(width=2048, height=2048, output_resolution=2048,
                                           num_inference_steps=40, true_cfg_scale=1.0, use_kv_cache=True)))


def test_decodes_full_resolution_png_and_allowlists_the_saved_receipt(helper, selected, response):
    response['metrics'].update(native_counts={'private-counter': 10},
                               native_fusions_sha256='b' * 64, stream='internal stream metadata',
                               prompt='private prompt', path='/internal/runtime/path')
    response['metrics']['settings']['private-option'] = 'discard me'
    response['private-extra'] = {'anything': 'discard me'}
    png, saved = helper.decode_response(json.dumps(response).encode(), selected)
    with Image.open(io.BytesIO(png)) as image:
        assert image.size == (2048, 2048) and image.mode == 'RGBA'
        assert image.getpixel((0, 0)) == (20, 100, 210, 120)
    assert saved == dict(precision_profile='exact', checkpoint_sha256='a' * 64,
                        settings=dict(width=2048, height=2048, output_resolution=2048,
                                      num_inference_steps=40, true_cfg_scale=1.0, use_kv_cache=True))


def test_legacy_response_without_precision_can_retain_available_receipt(helper, selected, response):
    response['metrics'].pop('precision_profile')
    png, saved = helper.decode_response(json.dumps(response).encode(), selected)
    assert png.startswith(b'\x89PNG\r\n\x1a\n')
    assert saved.get('precision_profile') is None
    assert saved['settings']['width'] == 2048


def test_legacy_response_without_metrics_is_decoded_for_adapter_validation(helper, selected, response):
    response.pop('metrics')
    png, saved = helper.decode_response(json.dumps(response).encode(), selected)
    assert png.startswith(b'\x89PNG\r\n\x1a\n')
    assert saved == {}


@pytest.mark.parametrize('payload', [None, [], 'image', {}, {'data': []}, {'data': [None]},
    {'data': [{}, {}]}, {'data': [{}]}, {'data': [{'b64_json': None}]},
    {'data': [{'b64_json': '!invalid-base64!'}]},
    {'data': [{'b64_json': base64.b64encode(b'not a PNG').decode()}]},
])
def test_rejects_malformed_or_unexpected_response_before_saving(helper, selected, payload):
    with pytest.raises(ValueError):
        helper.decode_response(json.dumps(payload).encode(), selected)


def test_rejects_oversized_response_at_decode_boundary(helper, selected):
    with pytest.raises(ValueError, match='size|large|exceed'):
        helper.decode_response(b' ' * (40 * 1024**2 + 1), selected)


@pytest.mark.parametrize('metrics', [None, [], 'invalid'])
def test_rejects_malformed_metrics_object(helper, selected, response, metrics):
    response['metrics'] = metrics
    with pytest.raises(ValueError):
        helper.decode_response(json.dumps(response).encode(), selected)


@pytest.mark.parametrize('settings', [None, [], 'invalid'])
def test_rejects_malformed_settings_object(helper, selected, response, settings):
    response['metrics']['settings'] = settings
    with pytest.raises(ValueError):
        helper.decode_response(json.dumps(response).encode(), selected)


def test_saved_request_uses_local_json_api_and_publishes_png_with_receipt(
        helper, selected, response, tmp_path, monkeypatch):
    request = dict(profile=selected, prompt='A blue glass teapot', seed=0)
    (tmp_path / 'request.json').write_text(json.dumps(request))
    monkeypatch.setattr(helper, 'Path', lambda value: tmp_path if value == '/job' else Path(value))
    calls = []

    def respond(call, timeout):
        calls.append((call, timeout))
        return io.BytesIO(json.dumps(response).encode())

    monkeypatch.setattr(helper.urllib.request, 'urlopen', respond)
    helper.main()
    assert len(calls) == 1
    call, timeout = calls[0]
    assert call.full_url == 'http://127.0.0.1:8191/v1/images/generations'
    assert call.get_method() == 'POST' and timeout > 0
    assert json.loads(call.data) == dict(model='paiton-image-2.1', prompt=request['prompt'], seed=0,
                                       size='2048x2048', mode='rgba', n=1, steps=40,
                                       guidance=1.0, response_format='b64_json')
    assert json.loads((tmp_path / 'result-metadata.json').read_text()) == response['metrics']
    with Image.open(tmp_path / 'result.png') as image:
        assert image.size == (2048, 2048) and image.mode == 'RGBA'
    assert not list(tmp_path.glob('*.part'))


def test_response_receipt_preserves_model_identity_and_discards_private_metrics(helper, selected, response):
    response['metrics'].update(model='paiton-image-2.1-uncensored', model_variant='uncensored',
                               private_model_path='/models/private', native_counts={'internal': 1})
    _, saved = helper.decode_response(json.dumps(response).encode(), selected)
    assert saved['model'] == 'paiton-image-2.1-uncensored'
    assert saved['model_variant'] == 'uncensored'
    assert 'private_model_path' not in saved and 'native_counts' not in saved


@pytest.mark.parametrize('package,api_model', [('qwen-image21', 'paiton-image-2.1'),
    ('qwen-image21-uncensored', 'paiton-image-2.1-uncensored')])
def test_edit_uses_json_endpoint_and_only_the_prepared_job_source(
        helper, response, tmp_path, monkeypatch, package, api_model):
    selected = dict(package=package, mode='edit', width=1024, height=1024, steps=40, guidance=1.0)
    request = dict(profile=selected, prompt='Turn the sky blue', seed=42,
                   source=dict(path='/untrusted/source/path/ignored.png'))
    (tmp_path / 'request.json').write_text(json.dumps(request))
    source = io.BytesIO()
    Image.new('RGBA', (160, 90), (20, 60, 200, 120)).save(source, format='PNG')
    (tmp_path / 'source.png').write_bytes(source.getvalue())
    monkeypatch.setattr(helper, 'Path', lambda value: tmp_path if value == '/job' else Path(value))
    calls = []
    def respond(call, timeout):
        calls.append(call)
        return io.BytesIO(json.dumps(response).encode())
    monkeypatch.setattr(helper.urllib.request, 'urlopen', respond)
    helper.main()
    assert len(calls) == 1
    call = calls[0]
    assert call.full_url == 'http://127.0.0.1:8191/v1/images/edits'
    assert call.headers['Content-type'] == 'application/json'
    body = json.loads(call.data)
    assert body == dict(model=api_model, prompt=request['prompt'], seed=42,
                        size='1024x1024', mode='edit', n=1, steps=40, guidance=1.0,
                        response_format='b64_json', image_b64=base64.b64encode(source.getvalue()).decode())
    assert 'source' not in body and 'image_url' not in body
    assert (tmp_path / 'source.png').read_bytes() == source.getvalue()


def test_edit_without_prepared_source_cannot_contact_runtime(helper, tmp_path, monkeypatch):
    request = dict(profile=dict(package='qwen-image21', mode='edit', width=1024, height=1024,
                                steps=40, guidance=1.0), prompt='Blue sky', seed=0)
    (tmp_path / 'request.json').write_text(json.dumps(request))
    monkeypatch.setattr(helper, 'Path', lambda value: tmp_path if value == '/job' else Path(value))
    monkeypatch.setattr(helper.urllib.request, 'urlopen', lambda *args, **kwargs: pytest.fail('Missing source must fail before HTTP'))
    with pytest.raises((ValueError, FileNotFoundError)):
        helper.main()
    assert not (tmp_path / 'result.png').exists()


def test_uncensored_creation_uses_its_model_id_without_image_attachment(helper, response, tmp_path, monkeypatch):
    request = dict(profile=dict(package='qwen-image21-uncensored', width=2048, height=2048,
                                steps=40, guidance=1.0, mode='text-to-image'), prompt='Blue teapot', seed=0)
    (tmp_path / 'request.json').write_text(json.dumps(request))
    monkeypatch.setattr(helper, 'Path', lambda value: tmp_path if value == '/job' else Path(value))
    calls = []
    def respond(call, timeout):
        calls.append(call)
        return io.BytesIO(json.dumps(response).encode())
    monkeypatch.setattr(helper.urllib.request, 'urlopen', respond)
    helper.main()
    assert len(calls) == 1 and calls[0].full_url.endswith('/images/generations')
    body = json.loads(calls[0].data)
    assert body['model'] == 'paiton-image-2.1-uncensored' and body['size'] == '2048x2048'
    assert 'image_b64' not in body
