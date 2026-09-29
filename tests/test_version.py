"""Version identity comes from VERSION, then this checkout's git, then the packaged build record; never from guesses."""
import json
from pathlib import Path
from subprocess import CompletedProcess

import pytest
from fastapi.testclient import TestClient

from studio import version as studio_version
from studio.app import create_app

ROOT = Path(__file__).resolve().parents[1]
RECORD = {'git_sha': 'abc1234', 'built_at': '2026-09-26T08:00:00+00:00'}


def checkout(tmp_path, *, git=False, build_info=None, name='studio-copy'):
    root = tmp_path / name
    root.mkdir()
    (root / 'VERSION').write_text('1.2.3\n')
    if git:
        (root / '.git').mkdir()
    record = root / 'build_info.json'
    if build_info is not None:
        record.write_text(json.dumps(build_info))
    return root, record


def test_version_file_is_the_single_source_shared_with_package_json():
    assert studio_version.version() == (ROOT / 'VERSION').read_text().strip()
    assert json.loads((ROOT / 'package.json').read_text())['version'] == studio_version.version()
    assert studio_version.version(ROOT / 'missing') == 'unknown'


def test_checkout_reports_live_git_once_and_the_build_record_separately(tmp_path, monkeypatch):
    root, record = checkout(tmp_path, git=True, build_info=RECORD)
    calls = []
    def fake_run(args, **kwargs):
        calls.append(args)
        return CompletedProcess(args, 0, 'fed9876\n', '')
    monkeypatch.setattr(studio_version.subprocess, 'run', fake_run)
    assert studio_version.version_info(root, record) == {'version': '1.2.3', 'git_sha': 'fed9876', 'build': RECORD}
    assert calls[0][:2] == ['git', '-C'] and calls[0][2:] == [str(root), 'rev-parse', '--short', 'HEAD']
    record.unlink()
    assert studio_version.version_info(root, record) == {'version': '1.2.3', 'git_sha': 'fed9876'}
    record.write_text('not json')
    assert studio_version.version_info(root, record) == {'version': '1.2.3', 'git_sha': 'fed9876'}
    assert len(calls) == 1, 'the revision is read once per process, not per request'
    assert studio_version.label({'version': '1.2.3', 'git_sha': 'fed9876'}) == 'Studio 1.2.3 (fed9876)'


def test_zip_install_reports_the_packaged_revision(tmp_path, monkeypatch):
    root, record = checkout(tmp_path, build_info=RECORD)
    monkeypatch.setattr(studio_version.subprocess, 'run', lambda *args, **kwargs: pytest.fail('No .git directory means no git call'))
    assert studio_version.version_info(root, record) == {'version': '1.2.3', 'git_sha': 'abc1234', 'build': RECORD}
    record.write_text(json.dumps({'built_at': RECORD['built_at']}))
    assert studio_version.version_info(root, record) == {
        'version': '1.2.3', 'git_sha': 'unknown', 'build': {'git_sha': 'unknown', 'built_at': RECORD['built_at']}}
    record.write_text('[1, 2]')
    assert studio_version.version_info(root, record) == {'version': '1.2.3', 'git_sha': 'unknown'}


def test_missing_or_failing_git_reports_unknown(tmp_path, monkeypatch):
    root, record = checkout(tmp_path)
    monkeypatch.setattr(studio_version.subprocess, 'run', lambda *args, **kwargs: pytest.fail('No .git directory means no git call'))
    assert studio_version.version_info(root, record) == {'version': '1.2.3', 'git_sha': 'unknown'}
    root, record = checkout(tmp_path, git=True, name='broken-git')
    def failing(args, **kwargs):
        raise OSError('git is not installed')
    monkeypatch.setattr(studio_version.subprocess, 'run', failing)
    assert studio_version.version_info(root, record)['git_sha'] == 'unknown'


def test_version_route_is_session_gated_and_matches_system_details(tmp_path, monkeypatch):
    info = {'version': '1.2.3', 'git_sha': 'abc1234', 'build': {'git_sha': 'abc1234', 'built_at': None}}
    monkeypatch.setattr('studio.app.version_info', lambda: dict(info))
    monkeypatch.setattr('studio.system_info.SystemInfo.snapshot', lambda self, force=False: {'schema_version': 1})
    with TestClient(create_app(tmp_path, config={}, worker_enabled=False)) as client:
        assert client.get('/api/version').status_code == 401
        client.headers['X-Studio-Token'] = client.get('/api/session').json()['token']
        assert client.get('/api/version').json() == info
        assert client.get('/api/system').json()['studio'] == info
