import errno
import io
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import pytest
from studio.archives import atomic_archive, export_path, ExportFileResponse
from studio.store import Store


def test_archive_is_disk_backed_and_published_only_when_complete(tmp_path):
    destination = tmp_path/'project.zip'
    source = tmp_path/'media.bin'; source.write_bytes(b'actual media fixture' * 100000)
    with atomic_archive(destination) as archive:
        assert archive.fp.fileno() >= 0
        assert not isinstance(archive.fp, io.BytesIO)
        assert not destination.exists()
        archive.write(source, 'media.bin')
    with zipfile.ZipFile(destination) as archive:
        assert archive.read('media.bin') == source.read_bytes()
    assert not list(tmp_path.glob('.*.tmp'))


@pytest.mark.parametrize('error', [ValueError('fixture failure'), OSError(errno.ENOSPC, 'fixture disk full')])
def test_partial_exports_are_removed_and_previous_download_preserved(tmp_path, error):
    destination = tmp_path/'previous.zip'; destination.write_bytes(b'previous complete download')
    with pytest.raises(ValueError):
        with atomic_archive(destination) as archive:
            archive.writestr('first.txt', 'Some data')
            raise error
    assert destination.read_bytes() == b'previous complete download'
    assert not list(tmp_path.glob('.*.tmp'))


def test_concurrent_exports_never_replace_each_other(tmp_path):
    store = Store(tmp_path)
    def create(content):
        destination = export_path(store, 'same-project')
        with atomic_archive(destination) as archive:
            archive.writestr('value', content)
        return destination
    with ThreadPoolExecutor(max_workers=2) as pool:
        paths = list(pool.map(create, ['first revision', 'second revision']))
    assert paths[0] != paths[1]
    for path, expected in zip(paths, ['first revision', 'second revision']):
        with zipfile.ZipFile(path) as archive:
            assert archive.read('value').decode() == expected


def test_download_removes_only_its_own_archive(tmp_path):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    first, second = tmp_path/'first.zip', tmp_path/'second.zip'
    first.write_bytes(b'download bytes'); second.write_bytes(b'another download')
    app = FastAPI()
    @app.get('/download')
    def download(): return ExportFileResponse(first, filename='project.zip')
    with TestClient(app) as client:
        response = client.get('/download')
        assert response.content == b'download bytes'
    assert not first.exists() and second.exists()


def test_disconnect_also_releases_this_archive(tmp_path):
    import asyncio
    path = tmp_path/'download.zip'; path.write_bytes(b'download bytes')
    async def send(_): raise ConnectionError('Disconnected fixture')
    async def receive(): return {'type': 'http.disconnect'}
    with pytest.raises(ConnectionError):
        asyncio.run(ExportFileResponse(path)({'type':'http', 'method':'GET', 'headers':[]}, receive, send))
    assert not path.exists()


def test_disk_full_before_export_directory_exists_has_recovery_message(tmp_path, monkeypatch):
    destination = tmp_path/'exports'/'new.zip'
    def no_space(*args, **kwargs): raise OSError(errno.ENOSPC, 'fixture full disk')
    monkeypatch.setattr(Path, 'mkdir', no_space)
    with pytest.raises(ValueError, match='free some space and retry'):
        with atomic_archive(destination):
            pytest.fail('Archive cannot start on a full disk')
    assert not destination.exists()
