"""Native controller locks behind an OS boundary; no runtime qualification.

Linux is hardware-validated. The Windows standard-library adapter is exercised
through contract tests on Linux and still needs native Windows validation.
"""
import errno
import os
from pathlib import Path
import stat
import sys
import tempfile


class PosixLocks:
    def open(self, path):
        descriptor = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        try:
            info = os.fstat(descriptor)
            if info.st_uid != os.getuid():
                raise RuntimeError('Resource lock ownership mismatch.')
            if not stat.S_ISREG(info.st_mode):
                raise RuntimeError('Resource lock must be a regular file.')
            return descriptor
        except BaseException:
            os.close(descriptor)
            raise

    def acquire(self, descriptor):
        import fcntl
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except BlockingIOError:
            return False

    def close(self, descriptor):
        os.close(descriptor)

    def gpu_path(self):
        # Existing running Studio instances share this exact Linux lock.
        return Path('/tmp') / f'paiton-studio-gpu-{os.getuid()}.lock'


class WindowsLocks:
    def open(self, path):
        # Reject reparse points and substituted files before taking a lock.
        # No contents are read, truncated or written by the controller.
        self._check_path(path)
        descriptor = os.open(path, os.O_CREAT | os.O_RDWR | getattr(os, 'O_BINARY', 0), 0o600)
        try:
            os.set_inheritable(descriptor, False)
            info = os.fstat(descriptor)
            current = self._check_path(path)
            if not stat.S_ISREG(info.st_mode) or current is None or not os.path.samestat(info, current):
                raise RuntimeError('Resource lock must be an unchanged regular file.')
            return descriptor
        except BaseException:
            os.close(descriptor)
            raise

    @staticmethod
    def _check_path(path):
        try:
            info = os.lstat(path)
        except FileNotFoundError:
            return None
        if not stat.S_ISREG(info.st_mode) or getattr(info, 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
            raise RuntimeError('Resource lock must be a regular file, not a link or reparse point.')
        return info

    def acquire(self, descriptor):
        import msvcrt
        os.lseek(descriptor, 0, os.SEEK_SET)
        try:
            # Nonblocking, including empty files. Blocking LK_LOCK retries for
            # ten seconds and would stall the queue and application shutdown.
            msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
            return True
        except OSError as error:
            if error.errno in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                return False
            raise

    def close(self, descriptor):
        # Closing the descriptor releases its byte-range lock even if an
        # exception occurred between acquisition and handing it to the queue.
        os.close(descriptor)

    def gpu_path(self):
        return Path(tempfile.gettempdir()) / 'paiton-studio-gpu.lock'


def resource_locks():
    if sys.platform == 'win32':
        return WindowsLocks()
    if os.name == 'posix':
        return PosixLocks()
    raise RuntimeError('Studio resource locking is unavailable on this operating system.')
