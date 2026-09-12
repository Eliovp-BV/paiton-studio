"""Small, disposable display copies; project originals remain the source of truth."""
from contextlib import contextmanager
import hashlib
import io
import json
import os
import stat
import threading
from weakref import WeakValueDictionary

from PIL import Image, ImageOps

from .store import atomic, safe_path


MAX_PIXELS = 32_000_000
MAX_SOURCE_BYTES = 32 * 1024 * 1024
SIZES = (128, 256, 384, 512)


def fingerprint(details):
    return (details.st_size, details.st_mtime_ns, details.st_ctime_ns,
            details.st_dev, details.st_ino)


class Thumbnails:
    def __init__(self, store):
        self.store = store
        self._locks = WeakValueDictionary()
        self._guard = threading.Lock()
        # Limit simultaneous full-image decodes on consumer systems. Request
        # handlers run off the event loop, independently of the inference queue.
        self._decoders = threading.BoundedSemaphore(2)

    @contextmanager
    def _lock(self, key):
        with self._guard:
            lock = self._locks.get(key)
            if lock is None:
                lock = threading.Lock()
                self._locks[key] = lock
        with lock:
            yield

    def get(self, identity, width=384):
        if isinstance(width, bool) or not isinstance(width, int) or not 64 <= width <= 512:
            raise ValueError('Choose a preview size between 64 and 512 pixels.')
        size = next(value for value in SIZES if value >= width)
        asset = self.store.asset(identity)
        if asset['kind'] != 'image':
            raise ValueError('Image previews are available for image assets only.')
        source = self.store.file(asset)
        try:
            details = source.stat()
            if not stat.S_ISREG(details.st_mode) or not 0 < details.st_size <= MAX_SOURCE_BYTES:
                raise ValueError('This image is outside the supported preview size limit.')
            signature = fingerprint(details)
            # Stat-based invalidation avoids reading/hashing multi-megabyte
            # originals every time a project card becomes visible.
            key = hashlib.sha256(json.dumps((asset['id'], asset['path'], signature, size)).encode()).hexdigest()
            output = safe_path(self.store.root, f'preview-cache/images-v1/{key}.webp')
            with self._lock(key):
                if output.is_file():
                    return output
                with self._decoders:
                    content = self._render(source, signature, size)
                atomic(output, content)
            return output
        except (OSError, Image.DecompressionBombError) as error:
            raise ValueError('This image preview could not be created. Check that the original image is complete and available.') from error

    def _render(self, source, signature, size):
        with source.open('rb') as stream:
            if fingerprint(os.fstat(stream.fileno())) != signature:
                raise ValueError('The original image changed while preparing its preview. Reload to try again.')
            with Image.open(stream) as original:
                if original.format not in ('PNG', 'JPEG') or original.width * original.height > MAX_PIXELS:
                    raise ValueError('Choose a PNG or JPEG image smaller than 32 megapixels.')
                original.load()
                preview = ImageOps.exif_transpose(original)
                try:
                    preview.thumbnail((size, size), Image.Resampling.LANCZOS, reducing_gap=3)
                    converted = preview.convert('RGBA' if 'A' in preview.getbands() or 'transparency' in preview.info else 'RGB')
                    try:
                        # No EXIF, filename, or user metadata is copied into the
                        # derived display file. This never changes export quality.
                        buffer = io.BytesIO()
                        converted.save(buffer, format='WEBP', quality=84, method=4)
                    finally:
                        converted.close()
                finally:
                    preview.close()
            if fingerprint(os.fstat(stream.fileno())) != signature or fingerprint(source.stat()) != signature:
                raise ValueError('The original image changed while preparing its preview. Reload to try again.')
        return buffer.getvalue()
