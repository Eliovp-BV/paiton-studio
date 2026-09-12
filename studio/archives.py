"""Disk-backed immutable export files: bounded media memory and atomic publication."""
from contextlib import contextmanager
import errno
import os
from pathlib import Path
import zipfile
from fastapi.responses import FileResponse
from .store import uid


def export_path(store, identity):
    # A separate file per request prevents one download replacing another's bytes.
    return store.root / 'exports' / f'{identity}-{uid()}.zip'


@contextmanager
def atomic_archive(destination):
    destination = Path(destination)
    temporary = destination.with_name('.' + destination.name + '.' + uid() + '.tmp')
    try:
        destination.parent.mkdir(parents=True, exist_ok=True)
        with temporary.open('xb') as stream:
            with zipfile.ZipFile(stream, 'w', zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
                yield archive
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, destination)
    except OSError as error:
        if error.errno in (errno.ENOSPC, errno.EDQUOT):
            raise ValueError('Not enough disk space to finish the export. Your saved project is unchanged; free some space and retry.') from error
        raise
    finally:
        temporary.unlink(missing_ok=True)


class ExportFileResponse(FileResponse):
    """Release only this request's completed archive, including disconnected clients."""
    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            Path(self.path).unlink(missing_ok=True)
