# SPDX-License-Identifier: AGPL-3.0-or-later
"""Offer the reviewed application source, without user data or runtime packages."""
import io
import json
from pathlib import Path, PurePosixPath
import zipfile

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / 'source-manifest.json'


def source_paths():
    """The packaged manifest also works when Studio was installed from a ZIP."""
    names = json.loads(MANIFEST.read_text(encoding='utf-8'))['files']
    if not isinstance(names, list) or any(not isinstance(name, str) for name in names):
        raise ValueError('Invalid application source manifest')
    if len(names) != len(set(names)):
        raise ValueError('Invalid application source manifest')
    for name in names:
        if '\\' in name or ':' in name or '\x00' in name:
            raise ValueError('Invalid application source path')
        path = PurePosixPath(name)
        if not path.parts or path.is_absolute() or str(path) != name or '..' in path.parts:
            raise ValueError('Invalid application source path')
        if name != '.gitignore' and any(part.startswith('.') for part in path.parts):
            raise ValueError('Private paths cannot be offered as application source')
        if path.parts[0] in {'docs', 'research'} or path.name in {'AGENTS.md', 'config.local.json'}:
            raise ValueError('Private paths cannot be offered as application source')
    return names


def source_archive(root=ROOT):
    root = Path(root).resolve()
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name in sorted(source_paths()):
            path = root / name
            if not path.is_file() or any(
                p.is_symlink() for p in (path, *path.parents) if p.is_relative_to(root)
            ) or not path.resolve().is_relative_to(root):
                continue
            info = zipfile.ZipInfo.from_file(path, arcname='paiton-studio/' + name)
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, path.read_bytes())
    return output.getvalue()
