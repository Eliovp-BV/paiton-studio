import json
import os
from types import SimpleNamespace

import pytest

from studio import diagnostics
from studio.store import Store


@pytest.fixture
def job_store(tmp_path):
    store = Store(tmp_path / 'data')
    project = store.create_project('Synthetic project')
    job = store.enqueue(project['id'], {'prompt': 'private conversation text'})
    return store, job['id']


@pytest.fixture
def setup_manager(tmp_path):
    root = tmp_path / 'data'
    root.mkdir()

    def job(identity):
        if identity != 'setup-1':
            raise ValueError('Setup request not found.')
        return {'id': identity, 'package': 'sample'}

    return SimpleNamespace(root=root, job=job)


def test_known_job_with_no_logs_returns_unavailable(job_store):
    store, identity = job_store
    assert diagnostics.read_job_log(store, identity) == {
        'available': False, 'text': '', 'truncated': False,
    }


@pytest.mark.parametrize('identity', ['unknown', '../private', '/tmp/private', 'a/b', '', None])
def test_unknown_and_unsafe_job_ids_are_rejected(job_store, identity):
    store, _ = job_store
    with pytest.raises(ValueError, match='Request not found'):
        diagnostics.read_job_log(store, identity)
    with pytest.raises(ValueError, match='Request not found'):
        diagnostics.write_job_log(store, identity, 'error')
    assert not (store.root / 'logs').exists()


def test_request_files_are_never_read(job_store):
    store, identity = job_store
    directory = store.root / 'jobs' / identity
    directory.mkdir(parents=True)
    (directory / 'writing-request.json').write_text('{"prompt":"private prompt"}')
    (directory / 'writing-response.json').write_text('{"text":"private reply"}')
    assert not diagnostics.read_job_log(store, identity)['available']
    with pytest.raises(ValueError, match='Unsupported diagnostic log'):
        diagnostics.write_job_log(store, identity, 'error', 'writing-request.json')
    assert (directory / 'writing-request.json').read_text() == '{"prompt":"private prompt"}'


def test_job_log_is_sanitized_on_disk_and_when_served(job_store):
    store, identity = job_store
    raw = ('Failed downloading https://demo:password@registry.example/image?token=query-secret\n'
           'Authorization: Bearer bearer-secret\n'
           'HF_TOKEN=hf_1234567890abcdef\n'
           'File "/home/demo/private workspace/config.json", line 1\n'
           'No space left on device')
    result = diagnostics.write_job_log(store, identity, raw)
    path = store.root / 'logs' / 'jobs' / identity / 'runtime-container.log'
    assert result['available'] and not result['truncated']
    assert result == diagnostics.read_job_log(store, identity)
    for text in (result['text'], path.read_text()):
        for secret in ('password', 'query-secret', 'bearer-secret', 'hf_1234567890abcdef', '/home/demo'):
            assert secret not in text
        assert 'https://registry.example/image?[redacted]' in text
        assert 'No space left on device' in text
    assert path.stat().st_mode & 0o777 == 0o600


def test_legacy_failure_log_is_read_but_never_modified(job_store):
    store, identity = job_store
    path = store.root / 'jobs' / identity / 'runtime-error.log'
    path.parent.mkdir(parents=True)
    original = 'DNS failed for /home/demo/config.local.json\nerror detail'
    path.write_text(original)
    assert diagnostics.read_job_log(store, identity)['text'] == 'DNS failed for [local path]\nerror detail'
    assert path.read_text() == original
    diagnostics.write_job_log(store, identity, 'Current failure', 'runtime-error.log')
    assert diagnostics.read_job_log(store, identity)['text'] == 'Current failure'


@pytest.mark.parametrize('location', ['leaf', 'parent', 'root'])
def test_symlink_logs_are_rejected_without_reading_or_overwriting(job_store, tmp_path, location):
    store, identity = job_store
    outside = tmp_path / 'outside'
    outside.mkdir()
    secret = outside / 'secret'
    secret.write_text('unrelated private content')
    if location == 'leaf':
        parent = store.root / 'logs' / 'jobs' / identity
        parent.mkdir(parents=True)
        (parent / 'runtime-error.log').symlink_to(secret)
    elif location == 'parent':
        (store.root / 'logs').symlink_to(outside, target_is_directory=True)
    else:
        alias = tmp_path / 'alias'
        alias.symlink_to(store.root, target_is_directory=True)
        store.root = alias
    with pytest.raises(ValueError, match='Diagnostic log'):
        diagnostics.read_job_log(store, identity)
    with pytest.raises(ValueError, match='Diagnostic log'):
        diagnostics.write_job_log(store, identity, 'replacement', 'runtime-error.log')
    assert secret.read_text() == 'unrelated private content'
    assert list(outside.iterdir()) == [secret]


def test_hardlinked_log_is_rejected(job_store, tmp_path):
    store, identity = job_store
    secret = tmp_path / 'secret'
    secret.write_text('private linked content')
    path = store.root / 'logs' / 'jobs' / identity / 'runtime-error.log'
    path.parent.mkdir(parents=True)
    os.link(secret, path)
    with pytest.raises(ValueError, match='private regular file'):
        diagnostics.read_job_log(store, identity)
    with pytest.raises(ValueError, match='private regular file'):
        diagnostics.write_job_log(store, identity, 'replacement', 'runtime-error.log')
    assert secret.read_text() == 'private linked content'


def test_non_regular_log_does_not_block_reader(job_store):
    store, identity = job_store
    path = store.root / 'logs' / 'jobs' / identity / 'runtime-error.log'
    path.parent.mkdir(parents=True)
    os.mkfifo(path)
    with pytest.raises(ValueError, match='private regular file'):
        diagnostics.read_job_log(store, identity)


def test_bounded_tail_keeps_recent_failure_and_drops_split_secret(job_store):
    store, identity = job_store
    path = store.root / 'jobs' / identity / 'runtime-error.log'
    path.parent.mkdir(parents=True)
    path.write_text('Authorization: Bearer ' + 'SECRET' * diagnostics.MAX_LOG_BYTES + '\nLatest DNS failure\n')
    result = diagnostics.read_job_log(store, identity)
    assert result == {'available': True, 'text': 'Latest DNS failure', 'truncated': True}
    written = diagnostics.write_job_log(store, identity, 'older progress\n' * 20000 + 'Latest download failure')
    saved = store.root / 'logs' / 'jobs' / identity / 'runtime-container.log'
    assert written['truncated']
    assert written['text'].endswith('Latest download failure')
    assert saved.stat().st_size <= diagnostics.MAX_LOG_BYTES
    assert len(written['text'].encode()) <= diagnostics.MAX_LOG_BYTES


def test_redaction_hides_credentials_urls_and_cross_platform_paths():
    original = ('401 Bearer opaque-value\nBasic dXNlcjpwYXNz\n'
                'API_KEY=key-secret\nCookie: session=session-secret\n'
                'Use sk-1234567890abcdef or ghp_1234567890abcdef\n'
                'failed https://user:pass@[::1]:5000/file?signature=url-secret#private-fragment\n'
                'File "C:\\Users\\Private Person\\config.json"\n'
                r'File \\host\share\private' '\nFile /home/private-person/file\n'
                '\x1b[31mDownload failed\x1b[0m')
    result = diagnostics.redact(original)
    for secret in ('opaque-value', 'dXNlcjpwYXNz', 'key-secret', 'session-secret',
                   'sk-1234567890abcdef', 'ghp_1234567890abcdef', 'user:pass',
                   'url-secret', 'private-fragment', 'Private Person', 'private-person', 'share', '\x1b'):
        assert secret not in result
    assert 'https://[::1]:5000/file?[redacted]' in result
    assert 'Download failed' in result


def test_terminal_controls_cannot_hide_credential_keys_or_spoof_url_placeholders():
    result = diagnostics.redact('Authori\x1b[31mzation: private-secret\n\x00URL99999\x00\nError')
    assert 'private-secret' not in result
    assert result.endswith('Error')


def test_non_http_urls_drop_credentials_and_filesystem_urls_are_private():
    result = diagnostics.redact('ftp://user:private-password@mirror.example/model?key=private-query\n'
                                'file:///home/private-person/weights\nunix:///private/docker.sock')
    assert 'ftp://mirror.example/model?[redacted]' in result
    assert 'private' not in result


@pytest.mark.parametrize('payload', [
    {'messages': [{'role': 'user', 'content': 'private conversation'}]},
    {'request': {'prompt': 'private conversation'}},
    {'output': 'private conversation'},
    {'settings': {'api_key': 'private conversation'}},
])
def test_multiline_json_payload_records_are_omitted_with_following_errors_kept(payload):
    original = 'starting\n' + json.dumps(payload, indent=2) + '\nHTTP error 429'
    result = diagnostics.redact(original)
    assert 'private conversation' not in result
    assert 'HTTP error 429' in result
    assert 'starting' in result


def test_unstructured_multiline_prompt_dump_omits_its_remainder():
    result = diagnostics.redact('Runtime failed\nprompt:\nprivate unindented prose\nmore private prose')
    assert 'private unindented' not in result
    assert 'more private' not in result
    assert result.startswith('Runtime failed')


def test_setup_logs_validate_identity_append_and_cap(setup_manager):
    with pytest.raises(ValueError, match='Setup request not found'):
        diagnostics.read_setup_log(setup_manager, 'unknown')
    with pytest.raises(ValueError, match='Setup request not found'):
        diagnostics.write_setup_log(setup_manager, '../other', 'error')
    assert not diagnostics.read_setup_log(setup_manager, 'setup-1')['available']
    diagnostics.write_setup_log(setup_manager, 'setup-1', 'First step')
    diagnostics.write_setup_log(setup_manager, 'setup-1', 'password=private\nSecond step', append=True)
    result = diagnostics.read_setup_log(setup_manager, 'setup-1')
    assert result['available'] and not result['truncated']
    assert result['text'].startswith('First step\n')
    assert result['text'].endswith('Second step')
    assert 'private' not in result['text']


@pytest.mark.parametrize(('text', 'code', 'retryable'), [
    ('OSError: [Errno 28] No space left on device', 'disk_full', False),
    ('HTTP Error 429: Too Many Requests', 'rate_limited', True),
    ('toomanyrequests: limit exceeded', 'rate_limited', True),
    ('docker pull access denied for example', 'pull_denied', False),
    ('HTTP Error 403: Forbidden', 'pull_denied', False),
    ('401 Client Error: Unauthorized for url', 'pull_denied', False),
    ('lookup ghcr.io: no such host', 'dns', True),
    ('Temporary failure in name resolution', 'dns', True),
    ('Unexpected confidential internal failure', 'unknown', False),
])
def test_specific_failure_messages_never_echo_raw_errors(text, code, retryable):
    result = diagnostics.classify_failure(text)
    assert result['code'] == code
    assert result['retryable'] is retryable
    assert result['message']
    assert text not in result['message']
    assert set(result) == {'code', 'message', 'retryable'}


def test_copy_bundle_uses_explicit_allowlist_and_one_sanitized_log():
    version = {'version': '1.2.3', 'git_sha': 'abc123', 'build': {'git_sha': 'abc123',
               'built_at': '2026-09-27', 'path': '/private/build'}, 'hostname': 'private-host'}
    readiness = {'environment': {'compatible': True, 'system': 'Linux', 'path': '/private/system'},
                 'models': [{'id': 'qwen', 'name': 'Text model', 'state': 'setup_required',
                             'qualified': True, 'target_dir': '/private/weights',
                             'blockers': ['Authorization: Bearer private-token']}],
                 'capabilities': [{'id': 'chat', 'state': 'setup_required', 'prompt': 'private prompt'}],
                 'conversations': ['private conversation']}
    host = {'platform': {'system': 'Linux', 'machine': 'x86_64', 'hostname': 'private-host'},
            'python_version': '3.12.3', 'driver': {'host_rocm_version': '10.0.0', 'host_rocm_source': '/private/rocm'},
            'gpu': {'name': 'R9700', 'architecture': 'gfx1201', 'total': 32768, 'message': 'private device'},
            'docker': {'available': True, 'server_version': '1.2', 'root_dir': '/private/docker',
                       'endpoint': 'https://user:secret@host'},
            'storage': {'data': {'state': 'ready', 'free_bytes': 1234, 'path': '/private/data'}},
            'session_token': 'private-session', 'config': {'api_key': 'private-api-key'}}
    log = {'available': True, 'text': 'No space left on device\nAuthorization: Bearer private-log-secret',
           'truncated': False, 'path': '/private/log'}
    bundle = diagnostics.diagnostics_bundle(version, readiness, host, log)
    bundle['request'] = {'prompt': 'private late addition'}
    text = diagnostics.diagnostics_text(bundle)
    assert 'private' not in text
    parsed = json.loads(text)
    assert parsed['version']['version'] == '1.2.3'
    assert parsed['host']['gpu']['architecture'] == 'gfx1201'
    assert parsed['host']['driver']['host_rocm_version'] == '10.0.0'
    assert parsed['host']['python_version'] == '3.12.3'
    assert parsed['host']['storage']['data']['free_bytes'] == 1234
    assert parsed['readiness']['models'][0]['qualified'] is True
    assert parsed['log']['text'].startswith('No space left on device')
    assert set(parsed) == {'schema_version', 'version', 'host', 'readiness', 'log'}


def test_copy_log_cap_accounts_for_redaction_expansion():
    bundle = diagnostics.diagnostics_bundle({}, log={
        'available': True, 'text': '/x\n' * 40000, 'truncated': False,
    })
    assert bundle['log']['truncated']
    assert len(bundle['log']['text'].encode()) <= diagnostics.MAX_LOG_BYTES


def test_execution_contract_keeps_pins_without_request_data():
    digest = 'ghcr.io/eliovp/paiton-vllm-plugin@sha256:' + 'a' * 64
    execution = {'task': 'write', 'state': 'failed', 'package': 'qwen38-mxfp4',
                 'profile_id': 'qwen38-mxfp4-chat', 'revision': 'b' * 40, 'runtime_image': digest,
                 'prompt': 'private prompt', 'path': '/private/model', 'request': {'messages': 'private messages'}}
    bundle = diagnostics.diagnostics_bundle({}, execution=execution)
    copied = json.loads(diagnostics.diagnostics_text(bundle))
    assert copied['execution']['runtime_image'] == digest
    assert copied['execution']['revision'] == 'b' * 40
    assert set(copied['execution']) == {'task', 'state', 'package', 'profile_id', 'revision', 'runtime_image'}
    assert 'private' not in json.dumps(copied)


def test_unsupported_safe_filesystem_adapter_fails_closed(job_store, monkeypatch):
    store, identity = job_store
    monkeypatch.setattr(os, 'supports_dir_fd', set())
    with pytest.raises(ValueError, match='unavailable on this platform'):
        diagnostics.read_job_log(store, identity)
