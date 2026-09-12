"""Durable resource lifetime; native locking is delegated to a platform adapter."""
from pathlib import Path
import threading
from .platform_resources import resource_locks

class Lease:
    def __init__(self,path):
        self.path=Path(path);self.fd=None;self._guard=threading.RLock()
        self._locks=resource_locks()
    def acquire(self):
        with self._guard:
            if self.fd is not None:return True
            descriptor=self._locks.open(self.path)
            try:
                if not self._locks.acquire(descriptor):
                    self._locks.close(descriptor);return False
                self.fd=descriptor
                return True
            except BaseException:
                self._locks.close(descriptor)
                raise
    def close(self):
        with self._guard:
            if self.fd is not None:
                descriptor=self.fd;self.fd=None;self._locks.close(descriptor)
    def __enter__(self):
        if not self.acquire():raise BlockingIOError('Another Studio controller is using this resource.')
        return self
    def __exit__(self,*args):self.close()

def gpu_lease():return Lease(resource_locks().gpu_path())
