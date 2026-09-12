"""Pin every controller operation to one local Docker transport.

Resolving a named context reads Docker's local metadata only. No context changes,
daemon requests, containers or downloads happen during resolution. The endpoint
is captured lazily so a new installation can open Studio without Docker present.
"""
import json
import os
from pathlib import Path
import subprocess
import threading
from urllib.parse import urlsplit


class DockerLocalError(RuntimeError):
    pass


def _local_endpoint(endpoint):
    if not isinstance(endpoint, str) or any(ord(char) < 32 for char in endpoint):
        raise DockerLocalError('The Docker endpoint could not be identified. Select a local Docker Engine and retry.')
    try:
        parsed = urlsplit(endpoint)
    except ValueError:
        raise DockerLocalError('The Docker endpoint is invalid. Select a local Docker Engine and retry.') from None
    if (parsed.scheme != 'unix' or parsed.netloc or not parsed.path.startswith('/')
            or parsed.query or parsed.fragment or not endpoint.startswith('unix:///')):
        raise DockerLocalError('Docker selects a remote or unsupported endpoint. Select a local Unix-socket Docker Engine on the Studio host, then retry.')
    return endpoint


def _resolve_endpoint(environ):
    context = environ.get('DOCKER_CONTEXT')
    if not context and environ.get('DOCKER_HOST'):
        return _local_endpoint(environ['DOCKER_HOST'])
    if not context:
        config = Path(environ.get('DOCKER_CONFIG') or Path.home() / '.docker') / 'config.json'
        try:
            with config.open('rb') as source:
                content = source.read(1024 * 1024 + 1)
            if len(content) > 1024 * 1024:
                raise ValueError()
            settings = json.loads(content)
            if not isinstance(settings, dict):
                raise ValueError()
            context = settings.get('currentContext')
            if context is not None and not isinstance(context, str):
                raise ValueError()
        except FileNotFoundError:
            pass
        except (OSError, ValueError):
            raise DockerLocalError('Docker context configuration could not be read. Fix the local Docker configuration and retry.') from None
    if not context or context == 'default':
        if environ.get('DOCKER_TLS') or environ.get('DOCKER_TLS_VERIFY'):
            raise DockerLocalError('Docker has TLS endpoint overrides. Select an explicit local Unix-socket Docker endpoint and retry.')
        return 'unix:///var/run/docker.sock'
    if not isinstance(context, str) or context.startswith('-') or len(context) > 256:
        raise DockerLocalError('The selected Docker context is invalid. Select a local Docker Engine and retry.')
    # Explicit context name closes the race with `docker context use` while
    # resolving. Context inspection itself reads local configuration only.
    try:
        result = subprocess.run(['docker', 'context', 'inspect', context, '--format', '{{json .Endpoints.docker.Host}}'],
                                env=environ, capture_output=True, text=True, timeout=1.5, check=False)
        if result.returncode:
            raise ValueError()
        endpoint = json.loads(result.stdout)
    except (OSError, subprocess.TimeoutExpired, ValueError):
        raise DockerLocalError('The selected Docker context could not be inspected. Start with a local Docker Engine and retry.') from None
    return _local_endpoint(endpoint)


class LocalDocker:
    def __init__(self):
        self._endpoint = None
        self._lock = threading.Lock()

    @property
    def endpoint(self):
        with self._lock:
            return self._endpoint

    def invocation(self, args, environ=None):
        """Return safe argv/env for a reviewed Docker operation, without running it.

        Arguments start with the subcommand, never caller-supplied global flags.
        Setup builds use Docker's daemon-bound default builder. Container command
        arguments are not rewritten, including any nested application --host.
        """
        if not isinstance(args, (tuple, list)) or not args or not all(isinstance(arg, str) for arg in args) or args[0] not in {
                'image', 'volume', 'inspect', 'ps', 'info', 'version', 'create',
                'run', 'start', 'stop', 'rm', 'exec', 'pull', 'build', 'top', 'logs'}:
            raise DockerLocalError('This Docker operation is outside the reviewed Studio adapter contract.')
        environment = dict(os.environ if environ is None else environ)
        with self._lock:
            if self._endpoint is None:
                self._endpoint = _resolve_endpoint(environment)
            endpoint = self._endpoint
        for name in ('DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH',
                     'BUILDX_BUILDER', 'BUILDKIT_HOST'):
            environment.pop(name, None)
        # Pin both the top-level CLI and child CLI plugins. The captured endpoint
        # never follows a later host/context override or `docker context use`.
        environment['DOCKER_HOST'] = endpoint
        command = list(args)
        if command[0] == 'build':
            if any(arg == '--builder' or arg.startswith('--builder=') for arg in command[1:]):
                raise DockerLocalError('Package builds must use the local Docker Engine default builder.')
            command[1:1] = ['--builder', 'default']
        return ['docker', '--host', endpoint, *command], environment
