"""A source download must build from a ZIP without exporting local work."""
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import zipfile

import pytest

from studio import mail_source


def test_manifest_covers_application_and_build_inputs():
    root = mail_source.ROOT
    names = set(mail_source.source_paths())
    suffixes = {'.py', '.jsx', '.js', '.css', '.svg', '.png', '.woff2', '.mjs'}
    required = {
        path.relative_to(root).as_posix()
        for folder in ('studio', 'web', 'scripts', 'tests')
        for path in (root / folder).rglob('*')
        if path.is_file() and path.suffix in suffixes
        and not any(part.startswith('.') or part == '__pycache__' for part in path.relative_to(root).parts)
    }
    required.update(path.relative_to(root).as_posix() for path in (root / 'studio/contracts').glob('*.json'))
    required.update(path.relative_to(root).as_posix() for path in (root / 'media/screenshots').glob('*.webp'))
    required.update({
        'README.md', 'USER_GUIDE.md', 'NOTICE.md', 'source-manifest.json',
        'studio/mail_core/LICENSE', 'studio/mail_core/NOTICE',
        'config.example.json', 'package.json', 'package-lock.json',
        'index.html', 'vite.config.js', 'requirements.txt',
        'requirements-mail-approval.txt', 'run.sh', 'run-meetings-secure.sh',
    })
    assert not required - names, f'Add reviewed public source files to source-manifest.json: {sorted(required - names)}'
    missing = sorted(name for name in names if not (root / name).is_file())
    assert not missing, f'Source manifest lists missing files: {missing}'


def test_archive_is_complete_and_runs_without_git_checkout(tmp_path, monkeypatch):
    with zipfile.ZipFile(io.BytesIO(mail_source.source_archive())) as archive:
        names = set(archive.namelist())
        for name in mail_source.source_paths():
            if (mail_source.ROOT / name).is_file():
                assert 'paiton-studio/' + name in names
        assert 'paiton-studio/studio/contracts/minicpm5-image.json' in names
        assert 'paiton-studio/run-meetings-secure.sh' in names
        assert 'paiton-studio/AGENTS.md' not in names
        assert 'paiton-studio/web/art/README.md' not in names
        archive.extractall(tmp_path)
    extracted = tmp_path / 'paiton-studio'
    assert not (extracted / '.git').exists()
    # This import previously failed because the required model contracts were missing.
    result = subprocess.run(
        [sys.executable, '-c', 'from studio import setup_catalog; assert setup_catalog.MINICPM_IMAGE'],
        cwd=extracted, env={**os.environ, 'PYTHONPATH': str(extracted)},
        capture_output=True, text=True, timeout=20,
    )
    assert result.returncode == 0, result.stderr
    monkeypatch.setattr(mail_source, 'MANIFEST', extracted / 'source-manifest.json')
    with zipfile.ZipFile(io.BytesIO(mail_source.source_archive(extracted))) as archive:
        assert set(archive.namelist()) == names


def test_private_unlisted_files_and_symlinked_folders_are_not_exported(tmp_path):
    (tmp_path / 'studio').mkdir()
    (tmp_path / 'studio/app.py').write_text('public source')
    for name in ('AGENTS.md', 'config.local.json', 'studio/private.py', 'studio/internal.md'):
        (tmp_path / name).write_text('private material')
    (tmp_path / 'web/art').mkdir(parents=True)
    (tmp_path / 'web/art/README.md').write_text('private generation report')
    (tmp_path / '.local/contracts').mkdir(parents=True)
    (tmp_path / '.local/contracts/minicpm5-image.json').write_text('private linked data')
    (tmp_path / 'studio/contracts').symlink_to(tmp_path / '.local/contracts', target_is_directory=True)
    (tmp_path / 'run.sh').symlink_to(tmp_path / 'config.local.json')
    with zipfile.ZipFile(io.BytesIO(mail_source.source_archive(tmp_path))) as archive:
        assert archive.namelist() == ['paiton-studio/studio/app.py']
        assert b'private' not in archive.read('paiton-studio/studio/app.py')


@pytest.mark.parametrize('name', [
    '../secret.py', '/secret.py', 'C:/secret.py', 'studio/../secret.py',
    r'studio\secret.py', '.data/secret.py', 'research/notes.py',
    'AGENTS.md', 'studio/config.local.json', '',
])
def test_manifest_rejects_private_or_nonportable_paths(tmp_path, monkeypatch, name):
    manifest = tmp_path / 'manifest.json'
    manifest.write_text(json.dumps({'files': [name]}))
    monkeypatch.setattr(mail_source, 'MANIFEST', manifest)
    with pytest.raises(ValueError):
        mail_source.source_archive(tmp_path)


@pytest.mark.skipif(os.name != 'posix', reason='POSIX executable permissions')
def test_launcher_executable_mode_is_preserved(tmp_path):
    launcher = tmp_path / 'run.sh'
    launcher.write_text('#!/bin/sh\n')
    launcher.chmod(0o755)
    with zipfile.ZipFile(io.BytesIO(mail_source.source_archive(tmp_path))) as archive:
        assert (archive.getinfo('paiton-studio/run.sh').external_attr >> 16) & 0o777 == 0o755
