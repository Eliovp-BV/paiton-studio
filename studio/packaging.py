"""Release packaging: the reviewed files listed in source-manifest.json become one ZIP.

The archive unpacks into a paiton-studio/ folder and carries
studio/build_info.json, so a ZIP install reports the version and revision it
was packaged from without a git checkout (see version.py).

    python -m studio.packaging paiton-studio-source.zip
"""
from datetime import datetime, timezone
import io
import json
from pathlib import Path, PurePosixPath
import sys
import zipfile

from .version import version, version_info

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / 'source-manifest.json'
PREFIX = 'paiton-studio/'
BUILD_RECORD = 'studio/build_info.json'
SHIPPED_FOLDERS = {'media', 'scripts', 'studio', 'tests', 'web'}
PRIVATE_NAMES = {'AGENTS.md', 'CLAUDE.md', 'config.local.json'}


def shipped_paths(manifest=None):
    """The manifest's files as portable relative POSIX paths inside the shipped tree."""
    listed = json.loads(Path(manifest or MANIFEST).read_text(encoding='utf-8'))['files']
    paths = []
    for name in listed:
        if not isinstance(name, str) or not name or '\\' in name or ':' in name or name.startswith('/'):
            raise ValueError(f'Manifest entry is not a portable relative path: {name!r}')
        parts = PurePosixPath(name).parts
        if '..' in parts or name != PurePosixPath(*parts).as_posix():
            raise ValueError(f'Manifest entry is not a plain path inside the shipped tree: {name!r}')
        if len(parts) > 1 and (parts[0] not in SHIPPED_FOLDERS or any(part.startswith('.') for part in parts)):
            raise ValueError(f'Manifest entry is outside the shipped folders: {name!r}')
        if parts[-1] in PRIVATE_NAMES:
            raise ValueError(f'Manifest entry names a private file: {name!r}')
        paths.append(name)
    return paths


def build_record(root=ROOT):
    """The packaging checkout's version and revision; a ZIP install passes its recorded revision on."""
    root = Path(root)
    return dict(version=version(root), git_sha=version_info(root, root / BUILD_RECORD)['git_sha'],
                built_at=datetime.now(timezone.utc).isoformat(timespec='seconds'))


def _real_file(root, name):
    """The file behind a manifest entry, or None when it is missing or reached through a link."""
    path = Path(root)
    for part in PurePosixPath(name).parts:
        path = path / part
        if path.is_symlink():
            return None
    return path if path.is_file() else None


def archive(root=ROOT, manifest=None):
    """The release ZIP as bytes: each present manifest file under paiton-studio/, then a fresh build record."""
    record = build_record(root)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as bundle:
        for name in shipped_paths(manifest):
            path = None if name == BUILD_RECORD else _real_file(root, name)
            if path is not None:
                bundle.write(path, PREFIX + name)
        entry = zipfile.ZipInfo(PREFIX + BUILD_RECORD, datetime.now().timetuple()[:6])
        entry.external_attr = 0o644 << 16
        entry.compress_type = zipfile.ZIP_DEFLATED
        bundle.writestr(entry, json.dumps(record, indent=2) + '\n')
    return buffer.getvalue()


def main(argv=None):
    args = sys.argv[1:] if argv is None else list(argv)
    if len(args) != 1:
        print('usage: python -m studio.packaging <destination.zip>', file=sys.stderr)
        return 2
    destination = Path(args[0])
    data = archive()
    destination.write_bytes(data)
    with zipfile.ZipFile(io.BytesIO(data)) as bundle:
        record = json.loads(bundle.read(PREFIX + BUILD_RECORD))
        count = len(bundle.namelist())
    print(f"{destination}: Studio {record['version']} ({record['git_sha']}), {count} files")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
