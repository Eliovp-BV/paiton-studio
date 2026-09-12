"""Real CPU display-copy tests; no model or GPU inference is involved."""
from concurrent.futures import ThreadPoolExecutor
import io
import time

from fastapi.testclient import TestClient
from PIL import Image
import pytest

from studio.app import create_app
from studio.store import Store
from studio.thumbnails import Thumbnails


def image_bytes(size=(1024, 512), mode='RGB', color='#cf942e', orientation=None, format='PNG'):
    buffer = io.BytesIO()
    with Image.new(mode, size, color) as image:
        exif = Image.Exif()
        if orientation:
            exif[274] = orientation
            exif[315] = 'Private author metadata'
        image.save(buffer, format=format, exif=exif)
    return buffer.getvalue()


@pytest.fixture
def workspace(tmp_path):
    store = Store(tmp_path / 'data')
    project = store.create_project()['id']
    asset = store.add_asset(project, 'image', 'Original', image_bytes(), '.png', {})
    return store, asset, Thumbnails(store)


def test_thumbnail_preserves_original_and_aspect_ratio(workspace):
    store, asset, thumbnails = workspace
    before = store.file(asset).read_bytes()
    result = thumbnails.get(asset['id'])
    with Image.open(result) as image:
        assert image.format == 'WEBP' and image.size == (384, 192)
    assert store.file(asset).read_bytes() == before
    assert store.asset(asset['id']) == asset
    assert result.is_relative_to(store.root / 'preview-cache')


def test_exif_orientation_is_applied_and_metadata_removed(workspace):
    store, asset, thumbnails = workspace
    original = image_bytes(size=(600, 300), orientation=6, format='JPEG')
    oriented = store.add_asset(asset['project'], 'image', 'Portrait', original, '.jpg', {})
    with Image.open(thumbnails.get(oriented['id'], 256)) as image:
        assert image.size == (128, 256)
        assert not image.getexif()
    assert store.file(oriented).read_bytes() == original


def test_transparency_and_small_image_dimensions_are_preserved(workspace):
    store, asset, thumbnails = workspace
    original = image_bytes(size=(40, 20), mode='RGBA', color=(10, 20, 30, 60))
    small = store.add_asset(asset['project'], 'image', 'Transparent', original, '.png', {})
    with Image.open(thumbnails.get(small['id'])) as image:
        assert image.size == (40, 20) and image.mode == 'RGBA'
        assert image.getpixel((10, 10))[3] == 60


def test_repeated_requests_use_cached_file_and_source_changes_invalidate(workspace, monkeypatch):
    store, asset, thumbnails = workspace
    result = thumbnails.get(asset['id'])
    original_render = thumbnails._render
    def forbidden(*args):
        raise AssertionError('An unchanged original must not be decoded twice.')
    monkeypatch.setattr(thumbnails, '_render', forbidden)
    assert thumbnails.get(asset['id']) == result
    assert thumbnails.get(asset['id'], 300) == result  # Four bounded size buckets.
    monkeypatch.setattr(thumbnails, '_render', original_render)
    store.file(asset).write_bytes(image_bytes(size=(512, 1024)))
    changed = thumbnails.get(asset['id'])
    assert changed != result
    with Image.open(changed) as image:
        assert image.size == (192, 384)


def test_simultaneous_requests_decode_only_once(workspace, monkeypatch):
    store, asset, thumbnails = workspace
    calls = []
    original_render = thumbnails._render
    def render(*args):
        calls.append(1)
        time.sleep(.03)
        return original_render(*args)
    monkeypatch.setattr(thumbnails, '_render', render)
    with ThreadPoolExecutor(max_workers=8) as pool:
        outputs = list(pool.map(lambda _: thumbnails.get(asset['id']), range(8)))
    assert len(set(outputs)) == 1 and len(calls) == 1
    assert not list((store.root / 'preview-cache').rglob('*.tmp'))


@pytest.mark.parametrize('width', [0, 63, 513, 100000, True, '384'])
def test_invalid_sizes_do_not_create_cache(workspace, width):
    store, asset, thumbnails = workspace
    with pytest.raises(ValueError, match='preview size'):
        thumbnails.get(asset['id'], width)
    assert not (store.root / 'preview-cache').exists()


def test_non_images_missing_assets_and_corrupt_images_are_rejected(workspace):
    store, asset, thumbnails = workspace
    text = store.add_asset(asset['project'], 'text', 'Document', b'private text', '.md', {})
    with pytest.raises(ValueError, match='image assets only'):
        thumbnails.get(text['id'])
    with pytest.raises(ValueError, match='Asset not found'):
        thumbnails.get('missing')
    store.file(asset).write_bytes(b'not an image')
    with pytest.raises(ValueError, match='could not be created'):
        thumbnails.get(asset['id'])
    assert not (store.root / 'preview-cache').exists()


def test_pixel_limit_rejects_before_decode(workspace, monkeypatch):
    store, asset, thumbnails = workspace
    monkeypatch.setattr('studio.thumbnails.MAX_PIXELS', 100)
    monkeypatch.setattr(Image.Image, 'load', lambda *args: pytest.fail('Oversized image decoded'))
    with pytest.raises(ValueError, match='megapixels'):
        thumbnails.get(asset['id'])
    assert not (store.root / 'preview-cache').exists()


def test_original_and_cache_paths_cannot_escape_workspace(workspace, tmp_path):
    store, asset, thumbnails = workspace
    outside = tmp_path / 'outside.png'
    outside.write_bytes(image_bytes())
    with store.connect() as db:
        db.execute('UPDATE assets SET path=? WHERE id=?', (str(outside), asset['id']))
    with pytest.raises(ValueError, match='outside the project'):
        thumbnails.get(asset['id'])
    with store.connect() as db:
        db.execute('UPDATE assets SET path=? WHERE id=?', (asset['path'], asset['id']))
    (store.root / 'preview-cache').symlink_to(tmp_path, target_is_directory=True)
    with pytest.raises(ValueError, match='outside the project'):
        thumbnails.get(asset['id'])
    assert not (tmp_path / 'images-v1').exists()


def test_source_change_during_decode_does_not_publish_a_stale_cache(workspace, monkeypatch):
    store, asset, thumbnails = workspace
    from studio import thumbnails as module
    transpose = module.ImageOps.exif_transpose
    def changed(image):
        result = transpose(image)
        store.file(asset).write_bytes(image_bytes(size=(400, 800)))
        return result
    monkeypatch.setattr(module.ImageOps, 'exif_transpose', changed)
    with pytest.raises(ValueError, match='original image changed'):
        thumbnails.get(asset['id'])
    assert not (store.root / 'preview-cache').exists()


def test_thumbnail_endpoint_requires_session_and_keeps_original_endpoint(tmp_path):
    app = create_app(tmp_path / 'app', config={}, worker_enabled=False)
    store = app.state.store
    project = store.create_project()['id']
    original = image_bytes()
    asset = store.add_asset(project, 'image', 'Original', original, '.png', {})
    path = '/api/assets/' + asset['id']
    with TestClient(app) as client:
        assert client.get(path + '/thumbnail').status_code == 401
        client.get('/api/session')
        response = client.get(path + '/thumbnail?width=256')
        assert response.status_code == 200
        assert response.headers['content-type'] == 'image/webp'
        assert response.headers['cache-control'] == 'no-store'
        with Image.open(io.BytesIO(response.content)) as image:
            assert image.size == (256, 128)
        assert client.get(path).content == original
        assert client.get(path + '/thumbnail?width=9999').status_code == 422
        assert client.get(path + '/thumbnail', headers={'Origin': 'https://other.invalid'}).status_code == 403
