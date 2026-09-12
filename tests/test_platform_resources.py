"""CPU-only resource contracts; Windows branches use stdlib substitutes."""
import errno
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

import pytest

from studio import platform_resources
from studio.resources import Lease, gpu_lease


def test_resources_import_does_not_require_posix_modules():
    program = '''
import builtins
original = builtins.__import__
def guarded(name, *args, **kwargs):
    if name == 'fcntl':
        raise ImportError('fcntl is unavailable on Windows')
    return original(name, *args, **kwargs)
builtins.__import__ = guarded
import studio.resources
'''
    subprocess.run([sys.executable, '-c', program], check=True, timeout=10)


@pytest.mark.skipif(os.name != 'posix', reason='Existing Linux GPU coordination contract')
def test_linux_gpu_lease_keeps_existing_process_coordination_path():
    assert gpu_lease().path == Path('/tmp') / f'paiton-studio-gpu-{os.getuid()}.lock'


@pytest.mark.skipif(os.name != 'posix', reason='Linux native cross-process lock regression')
def test_lease_excludes_other_process_and_releases_on_close(tmp_path):
    path = tmp_path / 'controller.lock'
    program = '''
import sys
from studio.resources import Lease
lease = Lease(sys.argv[1])
try:
    print('acquired' if lease.acquire() else 'busy')
finally:
    lease.close()
'''
    def attempt():
        return subprocess.run([sys.executable, '-c', program, str(path)], capture_output=True,
                              text=True, check=True, timeout=10).stdout.strip()
    with Lease(path):
        assert attempt() == 'busy'
    assert attempt() == 'acquired'


def test_windows_adapter_uses_nonblocking_byte_lock_and_preserves_errors(tmp_path, monkeypatch):
    adapter = platform_resources.WindowsLocks()
    descriptor = adapter.open(tmp_path / 'lock')
    calls = []
    fake = SimpleNamespace(LK_NBLCK=2, locking=lambda *args: calls.append(args))
    monkeypatch.setitem(sys.modules, 'msvcrt', fake)
    try:
        assert not os.get_inheritable(descriptor)
        os.lseek(descriptor, 15, os.SEEK_SET)
        assert adapter.acquire(descriptor)
        assert os.lseek(descriptor, 0, os.SEEK_CUR) == 0
        assert calls == [(descriptor, fake.LK_NBLCK, 1)]
        def fail(error):
            def operation(*args):
                raise OSError(error, 'test lock error')
            return operation
        fake.locking = fail(errno.EACCES)
        assert adapter.acquire(descriptor) is False
        fake.locking = fail(errno.EIO)
        with pytest.raises(OSError) as failure:
            adapter.acquire(descriptor)
        assert failure.value.errno == errno.EIO
    finally:
        adapter.close(descriptor)
    with pytest.raises(OSError):
        os.fstat(descriptor)


def test_windows_adapter_rejects_links_and_reparse_points(tmp_path, monkeypatch):
    adapter = platform_resources.WindowsLocks()
    target = tmp_path / 'target'
    target.write_bytes(b'untouched')
    link = tmp_path / 'link'
    link.symlink_to(target)
    with pytest.raises(RuntimeError, match='link or reparse'):
        adapter.open(link)
    info = os.lstat(target)
    monkeypatch.setattr(platform_resources.os, 'lstat', lambda path: SimpleNamespace(
        st_mode=info.st_mode, st_file_attributes=0x400))
    with pytest.raises(RuntimeError, match='link or reparse'):
        adapter.open(target)
    assert target.read_bytes() == b'untouched'


def test_windows_adapter_and_temp_location_are_selected_explicitly(tmp_path, monkeypatch):
    monkeypatch.setattr(platform_resources.sys, 'platform', 'win32')
    monkeypatch.setattr(platform_resources.tempfile, 'gettempdir', lambda: str(tmp_path))
    adapter = platform_resources.resource_locks()
    assert isinstance(adapter, platform_resources.WindowsLocks)
    assert adapter.gpu_path() == tmp_path / 'paiton-studio-gpu.lock'
