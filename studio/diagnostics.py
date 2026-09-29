"""Bounded, local diagnostics with explicit file and metadata allowlists.

This module never probes hardware, starts a process or reads request files.
Callers supply existing host/readiness snapshots and choose one failure log.
"""
from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import stat
from urllib.parse import urlsplit, urlunsplit
import uuid


MAX_LOG_BYTES = 128 * 1024
JOB_LOG_FILES = ('runtime-error.log', 'runtime-container.log')
_TRUNCATED = '[Earlier log output omitted.]\n'
_IDENTITY = re.compile(r'[A-Za-z0-9_-]{1,128}\Z')
_URL = re.compile(r'\b[a-z][a-z0-9+.-]*://[^\s<>"\']+', re.IGNORECASE)
_SECRET = re.compile(
    r'(?i)(?:authorization|(?:[\w-]+[_-])?(?:token|password|passwd|secret|api[_-]?key)|'
    r'cookie|set-cookie)\b["\']?\s*[:=]')
_PAYLOAD = re.compile(
    r'(?i)\b(?:prompt|messages|request(?:[_ -]body)?|response[_ -]body|payload|'
    r'body|content|input(?:_text)?|output_text|partial_text|generated_text)\b["\']?\s*[:=]')
_PAYLOAD_KEYS = frozenset(('prompt', 'prompt_text', 'messages', 'request', 'request_body',
    'response', 'response_body', 'payload', 'body', 'content', 'input', 'input_text',
    'output', 'output_text', 'text', 'completion', 'partial_text', 'generated_text'))


def _tail(value, limit=MAX_LOG_BYTES):
    raw = value.encode('utf-8') if isinstance(value, str) else bytes(value)
    truncated = len(raw) > limit
    if truncated:
        raw = raw[-limit:]
        # A severed first line may have lost the credential/payload key.
        raw = raw.partition(b'\n')[2] if b'\n' in raw else b''
    return raw.decode('utf-8', errors='replace'), truncated


def _private_json(value):
    pending = [value]
    while pending:
        value = pending.pop()
        if isinstance(value, dict):
            if any(str(key).lower() in _PAYLOAD_KEYS or _SECRET.search(str(key) + '=')
                   for key in value):
                return True
            pending.extend(value.values())
        elif isinstance(value, list):
            pending.extend(value)
    return False


def _omit_json_payloads(text):
    decoder = json.JSONDecoder()
    result, position = [], 0
    for _ in range(256):
        match = re.search(r'[\[{]', text[position:])
        if not match:
            break
        start = position + match.start()
        try:
            value, length = decoder.raw_decode(text[start:])
        except (ValueError, RecursionError):
            result.append(text[position:start + 1])
            position = start + 1
            continue
        result.append(text[position:start])
        result.append('[Private payload omitted]' if _private_json(value) else text[start:start + length])
        position = start + length
    result.append(text[position:])
    return ''.join(result)


def redact(text):
    """Remove recognized credentials, payload records, URLs' secrets and local paths."""
    text, _ = _tail(str(text))
    # Normalize controls before matching keys; coloured keys must not bypass
    # redaction. Removing NUL also keeps URL placeholders distinct from input.
    text = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', text)
    text = ''.join(character for character in text if character in '\t\r\n' or ord(character) >= 32)
    text = _omit_json_payloads(text)
    urls = []

    def url(match):
        try:
            parsed = urlsplit(match.group())
            host = parsed.hostname or ''
            if ':' in host:
                host = '[' + host + ']'
            if parsed.port:
                host += ':' + str(parsed.port)
            clean = urlunsplit((parsed.scheme, host, parsed.path, '', ''))
            if parsed.query or parsed.fragment:
                clean += '?[redacted]'
            if parsed.scheme.lower() in ('file', 'unix', 'npipe'):
                clean = '[local path]'
        except ValueError:
            clean = '[URL omitted]'
        urls.append(clean)
        return f'\x00URL{len(urls) - 1}\x00'

    text = _URL.sub(url, text)
    lines = []
    for line in text.splitlines():
        if _SECRET.search(line):
            lines.append('[Credential line omitted]')
            continue
        if _PAYLOAD.search(line):
            # Unstructured request dumps can continue without indentation or a
            # delimiter. Discard their remainder; structured JSON was handled
            # above without losing any following error record.
            lines.append('[Private payload and following output omitted]')
            break
        line = re.sub(r'(?i)\b(Bearer|Basic)\s+[^\s,;"\']+', r'\1 [redacted]', line)
        line = re.sub(r'(?i)\b(?:hf_|sk-|ghp_|github_pat_)[A-Za-z0-9_-]{8,}', '[redacted]', line)
        # Quoted paths may contain spaces. Protect URLs until local paths are gone.
        line = re.sub(r'''(["'])(?:/|[A-Za-z]:[\\/]|\\\\)[^"'\r\n]*\1''', '[local path]', line)
        line = re.sub(r'(?<![\w:])(?:[A-Za-z]:[\\/]|\\\\|/)[^\s<>"\']+', '[local path]', line)
        line = re.sub(r'\x00URL(\d+)\x00', lambda match: urls[int(match[1])], line)
        lines.append(line)
    return '\n'.join(lines)


def _validated(owner, identity, setup=False):
    message = 'Setup request not found.' if setup else 'Request not found.'
    if not isinstance(identity, str) or not _IDENTITY.fullmatch(identity):
        raise ValueError(message)
    try:
        record = owner.job(identity)
    except (ValueError, KeyError):
        raise ValueError(message) from None
    if not isinstance(record, dict) or record.get('id') != identity:
        raise ValueError(message)
    return Path(owner.root)


@contextmanager
def _directory(root, components, create=False):
    # A descriptor for every directory closes the parent-symlink race as well as
    # rejecting leaf symlinks. Unsupported platforms fail closed in this adapter.
    if os.open not in os.supports_dir_fd or not hasattr(os, 'O_NOFOLLOW'):
        raise ValueError('Safe diagnostic logs are unavailable on this platform.')
    descriptors = []
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    try:
        descriptor = os.open(root, flags)
        descriptors.append(descriptor)
        for component in components:
            if create:
                try:
                    os.mkdir(component, 0o700, dir_fd=descriptor)
                except FileExistsError:
                    pass
            descriptor = os.open(component, flags, dir_fd=descriptor)
            descriptors.append(descriptor)
        yield descriptor
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)


def _read(root, parts):
    try:
        with _directory(root, parts[:-1]) as directory:
            descriptor = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
            with os.fdopen(descriptor, 'rb') as stream:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                    raise ValueError('Diagnostic log is not a private regular file.')
                truncated = info.st_size > MAX_LOG_BYTES
                if truncated:
                    stream.seek(-MAX_LOG_BYTES, os.SEEK_END)
                raw = stream.read(MAX_LOG_BYTES)
                if truncated:
                    raw = raw.partition(b'\n')[2] if b'\n' in raw else b''
    except FileNotFoundError:
        return dict(available=False, text='', truncated=False)
    except OSError:
        raise ValueError('Diagnostic log is unavailable.') from None
    text = redact(raw.decode('utf-8', errors='replace'))
    text, expanded = _tail(text)
    return dict(available=True, text=text, truncated=truncated or expanded or text.startswith(_TRUNCATED.rstrip()))


def _write(root, parts, text, append=False):
    previous = _read(root, parts) if append else None
    text, truncated = _tail(text)
    text = redact(text)
    if previous and previous['available']:
        text = previous['text'] + '\n' + text
        truncated = truncated or previous['truncated']
    text, clipped = _tail(text, MAX_LOG_BYTES - len(_TRUNCATED.encode()))
    text = (_TRUNCATED if truncated or clipped else '') + text
    temporary = '.' + uuid.uuid4().hex + '.tmp'
    try:
        with _directory(root, parts[:-1], create=True) as directory:
            try:
                existing = os.stat(parts[-1], dir_fd=directory, follow_symlinks=False)
                if not stat.S_ISREG(existing.st_mode) or existing.st_nlink != 1:
                    raise ValueError('Diagnostic log is not a private regular file.')
            except FileNotFoundError:
                pass
            try:
                descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                     0o600, dir_fd=directory)
                with os.fdopen(descriptor, 'wb') as stream:
                    stream.write(text.encode('utf-8'))
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temporary, parts[-1], src_dir_fd=directory, dst_dir_fd=directory)
            finally:
                try:
                    os.unlink(temporary, dir_fd=directory)
                except FileNotFoundError:
                    pass
    except OSError:
        raise ValueError('Diagnostic log could not be saved.') from None
    return _read(root, parts)


def read_job_log(store, identity):
    """Return the first available allowlisted failure log for a known job."""
    root = _validated(store, identity)
    for base in (('logs', 'jobs', identity), ('jobs', identity)):
        for filename in JOB_LOG_FILES:
            log = _read(root, (*base, filename))
            if log['available'] and log['text']:
                return log
    return dict(available=False, text='', truncated=False)


def write_job_log(store, identity, text, filename='runtime-container.log'):
    root = _validated(store, identity)
    if filename not in JOB_LOG_FILES:
        raise ValueError('Unsupported diagnostic log.')
    return _write(root, ('logs', 'jobs', identity, filename), text)


def read_setup_log(manager, identity):
    return _read(_validated(manager, identity, setup=True), ('logs', 'setup', identity + '.log'))


def write_setup_log(manager, identity, text, append=False):
    return _write(_validated(manager, identity, setup=True), ('logs', 'setup', identity + '.log'), text, append)


def classify_failure(text):
    """Classify existing error text without returning any of its private details."""
    text = str(text).lower()
    failures = (
        ('disk_full', ('no space left on device', 'disk quota exceeded', 'errno 28'),
         'There is not enough free disk space. Free space on the Studio or Docker drive, then retry.', False),
        ('rate_limited', ('toomanyrequests', 'too many requests', 'rate limit', 'http error 429', 'status code 429'),
         'The download service is limiting requests. Wait a little, then retry; completed downloads are kept.', True),
        ('pull_denied', ('pull access denied', 'requested access to the resource is denied', 'authentication required',
                         'unauthorized:', 'http error 401', 'http error 403', 'status code 401', 'status code 403',
                         '401 client error', '403 client error', '401 unauthorized', '403 forbidden'),
         'The runtime or weights could not be downloaded because access was denied. Check the package access requirements, then retry.', False),
        ('dns', ('temporary failure in name resolution', 'name or service not known', 'no such host',
                 'getaddrinfo failed', 'could not resolve host', 'name resolution failed'),
         'Studio could not resolve the download server. Check the host network and DNS settings, then retry.', True),
    )
    for code, needles, message, retryable in failures:
        if any(needle in text for needle in needles):
            return dict(code=code, message=message, retryable=retryable)
    return dict(code='unknown', message='The local tool failed. Open Show details for the saved diagnostics.', retryable=False)


def _fields(value, names):
    if not isinstance(value, dict):
        return {}
    result = {}
    for key in names:
        item = value.get(key)
        if isinstance(item, str):
            result[key] = redact(item[:1024])
        elif item is None or isinstance(item, (bool, int, float)):
            if key in value:
                result[key] = item
    return result


def diagnostics_bundle(version, readiness=None, host=None, log=None, execution=None):
    """Copy-safe metadata and one chosen log; never include arbitrary snapshots."""
    version, readiness, host, log = (value if isinstance(value, dict) else {}
                                    for value in (version, readiness, host, log))
    result = dict(schema_version=1, version=_fields(version, ('version', 'git_sha')))
    if execution is not None:
        result['execution'] = _fields(execution, ('task', 'state', 'package', 'profile_id', 'revision', 'runtime_image'))
    if isinstance(version.get('build'), dict):
        result['version']['build'] = _fields(version['build'], ('git_sha', 'built_at'))
    gpu_fields = ('name', 'architecture', 'gpu_count', 'total', 'used', 'total_bytes',
                  'used_bytes', 'available', 'supported', 'driver_available')
    inventory = _fields(host, ('python_version',))
    for section, fields in (
        ('platform', ('system', 'machine', 'release', 'distribution', 'distribution_id', 'distribution_version')),
        ('gpu', gpu_fields), ('driver', ('name', 'version', 'host_rocm_version', 'container_rocm_version')),
        ('docker', ('available', 'local_daemon', 'client_version', 'server_version', 'api_version', 'os', 'architecture')),
        ('memory', ('total_bytes', 'available_bytes', 'swap_total_bytes', 'swap_free_bytes')),
        ('device_access', ('kfd_exists', 'kfd_read_write')),
    ):
        if section in host:
            inventory[section] = _fields(host[section], fields)
    if isinstance(host.get('gpus'), list):
        inventory['gpus'] = [_fields(gpu, gpu_fields) for gpu in host['gpus'][:16]]
    if isinstance(host.get('storage'), dict):
        inventory['storage'] = {name: _fields(host['storage'].get(name), ('state', 'total_bytes', 'used_bytes', 'free_bytes'))
                                for name in ('data', 'docker') if name in host['storage']}
    result['host'] = inventory
    result['readiness'] = dict(environment=_fields(readiness.get('environment'), ('compatible', 'status', 'system', 'machine')),
        models=[_fields(model, ('id', 'name', 'model', 'state', 'installed', 'integrated', 'qualified', 'next_action'))
                for model in readiness.get('models', [])[:64]] if isinstance(readiness.get('models'), list) else [],
        capabilities=[_fields(item, ('id', 'name', 'state')) for item in readiness.get('capabilities', [])[:32]]
                     if isinstance(readiness.get('capabilities'), list) else [])
    text, truncated = _tail(log.get('text', '') if isinstance(log.get('text'), str) else '')
    text, expanded = _tail(redact(text))
    result['log'] = dict(available=log.get('available') is True, text=text,
                         truncated=truncated or expanded or log.get('truncated') is True)
    return result


def diagnostics_text(bundle):
    """Serialize only a freshly allowlisted bundle, even if a caller adds fields."""
    return json.dumps(diagnostics_bundle(bundle.get('version'), bundle.get('readiness'),
                      bundle.get('host'), bundle.get('log'), bundle.get('execution')), indent=2, ensure_ascii=False) + '\n'
