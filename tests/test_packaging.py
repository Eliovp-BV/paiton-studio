"""A release ZIP must carry every reviewed file and its build record, and nothing private."""
import io
import json
import os
import subprocess
import sys
import zipfile

import pytest

from studio import packaging
from studio import version as studio_version


def names_in(data):
    with zipfile.ZipFile(io.BytesIO(data)) as bundle:
        return bundle.namelist()


def test_manifest_covers_application_and_build_inputs():
    root = packaging.ROOT
    names = set(packaging.shipped_paths())
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
        'README.md', 'USER_GUIDE.md', 'NOTICE.md', 'source-manifest.json', 'Makefile', 'VERSION',
        'config.example.json', 'package.json', 'package-lock.json',
        'index.html', 'vite.config.js', 'requirements.txt', 'run.sh', 'run-meetings-secure.sh',
    })
    assert not required - names, f'Add reviewed public source files to source-manifest.json: {sorted(required - names)}'
    missing = sorted(name for name in names if not (root / name).is_file())
    assert not missing, f'Source manifest lists missing files: {missing}'
    # The build record is generated at packaging time, never listed.
    assert packaging.BUILD_RECORD not in names


def test_archive_is_complete_and_runs_without_git_checkout(tmp_path):
    data = packaging.archive()
    names = set(names_in(data))
    for name in packaging.shipped_paths():
        if (packaging.ROOT / name).is_file():
            assert packaging.PREFIX + name in names
    assert 'paiton-studio/studio/contracts/minicpm5-image.json' in names
    assert 'paiton-studio/run-meetings-secure.sh' in names
    assert 'paiton-studio/AGENTS.md' not in names
    assert 'paiton-studio/web/art/README.md' not in names
    with zipfile.ZipFile(io.BytesIO(data)) as bundle:
        bundle.extractall(tmp_path)
    extracted = tmp_path / 'paiton-studio'
    assert not (extracted / '.git').exists()
    packaged = studio_version.version_info(extracted, extracted / 'studio/build_info.json')
    assert packaged['git_sha'] == studio_version.git_sha(packaging.ROOT) and packaged['build']['built_at']
    assert packaged['version'] == studio_version.version()
    # The extracted tree imports on its own; the model contracts travel with it.
    result = subprocess.run(
        [sys.executable, '-c', 'from studio import setup_catalog; assert setup_catalog.MINICPM_IMAGE'],
        cwd=extracted, env={**os.environ, 'PYTHONPATH': str(extracted)},
        capture_output=True, text=True, timeout=20,
    )
    assert result.returncode == 0, result.stderr
    # Packaging the ZIP install from its own manifest reproduces the file list.
    assert set(names_in(packaging.archive(extracted, extracted / 'source-manifest.json'))) == names


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
    data = packaging.archive(tmp_path)
    assert names_in(data) == ['paiton-studio/studio/app.py', 'paiton-studio/studio/build_info.json']
    with zipfile.ZipFile(io.BytesIO(data)) as bundle:
        assert b'private' not in bundle.read('paiton-studio/studio/app.py')
        record = json.loads(bundle.read('paiton-studio/studio/build_info.json'))
    assert record == {'version': 'unknown', 'git_sha': 'unknown', 'built_at': record['built_at']}


def test_archive_records_the_packaging_revision_and_a_zip_install_carries_it_on(tmp_path, monkeypatch):
    checkout = tmp_path / 'checkout'
    (checkout / 'studio').mkdir(parents=True)
    (checkout / '.git').mkdir()
    (checkout / 'VERSION').write_text('1.2.3\n')
    (checkout / 'studio/app.py').write_text('public source')
    (checkout / 'studio/build_info.json').write_text(json.dumps({'git_sha': 'stale00', 'built_at': '2026-01-01T00:00:00Z'}))
    manifest = tmp_path / 'manifest.json'
    manifest.write_text(json.dumps({'files': ['VERSION', 'studio/app.py', 'studio/build_info.json']}))
    monkeypatch.setattr(studio_version.subprocess, 'run',
                        lambda args, **kwargs: subprocess.CompletedProcess(args, 0, 'abc1234\n', ''))
    data = packaging.archive(checkout, manifest)
    assert names_in(data) == ['paiton-studio/VERSION', 'paiton-studio/studio/app.py', 'paiton-studio/studio/build_info.json']
    with zipfile.ZipFile(io.BytesIO(data)) as bundle:
        assert (bundle.getinfo('paiton-studio/studio/build_info.json').external_attr >> 16) & 0o777 == 0o644
        record = json.loads(bundle.read('paiton-studio/studio/build_info.json'))
        assert record['version'] == '1.2.3' and record['git_sha'] == 'abc1234' and record['built_at']
        bundle.extractall(tmp_path / 'install')
    install = tmp_path / 'install/paiton-studio'
    monkeypatch.setattr(studio_version.subprocess, 'run', lambda *args, **kwargs: pytest.fail('A ZIP install has no git checkout'))
    assert studio_version.version_info(install, install / 'studio/build_info.json') == {
        'version': '1.2.3', 'git_sha': 'abc1234', 'build': {'git_sha': 'abc1234', 'built_at': record['built_at']}}
    with zipfile.ZipFile(io.BytesIO(packaging.archive(install, manifest))) as bundle:
        assert json.loads(bundle.read('paiton-studio/studio/build_info.json'))['git_sha'] == 'abc1234'


@pytest.mark.parametrize('name', [
    '../secret.py', '/secret.py', 'C:/secret.py', 'studio/../secret.py',
    r'studio\secret.py', '.data/secret.py', 'research/notes.py',
    'AGENTS.md', 'studio/config.local.json', 'studio//app.py', '',
])
def test_manifest_rejects_private_or_nonportable_paths(tmp_path, name):
    manifest = tmp_path / 'manifest.json'
    manifest.write_text(json.dumps({'files': [name]}))
    with pytest.raises(ValueError):
        packaging.archive(tmp_path, manifest)


@pytest.mark.skipif(os.name != 'posix', reason='POSIX executable permissions')
def test_launcher_executable_mode_is_preserved(tmp_path):
    launcher = tmp_path / 'run.sh'
    launcher.write_text('#!/bin/sh\n')
    launcher.chmod(0o755)
    with zipfile.ZipFile(io.BytesIO(packaging.archive(tmp_path))) as bundle:
        assert (bundle.getinfo('paiton-studio/run.sh').external_attr >> 16) & 0o777 == 0o755


def test_command_line_writes_the_archive(tmp_path, capsys):
    destination = tmp_path / 'release.zip'
    assert packaging.main([str(destination)]) == 0
    assert 'paiton-studio/studio/build_info.json' in names_in(destination.read_bytes())
    assert capsys.readouterr().out.startswith(f'{destination}: Studio ')
    assert packaging.main([]) == 2
