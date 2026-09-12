"""All process calls are mocked; locality tests never contact a Docker daemon."""
import io
import json
import subprocess

import pytest

from studio import docker_local, runtime as runtime_module, setup as package_setup
from studio.docker_local import DockerLocalError, LocalDocker
from studio.runtime import Runtime, RuntimeFailure
from studio.setup import SetupManager, SetupFailure
from studio.store import Store


@pytest.fixture(autouse=True)
def isolated_docker_configuration(tmp_path, monkeypatch):
    monkeypatch.setenv('DOCKER_CONFIG', str(tmp_path / 'docker-config'))
    for name in ('DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY',
                 'DOCKER_CERT_PATH', 'BUILDX_BUILDER', 'BUILDKIT_HOST'):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(docker_local.subprocess, 'run', lambda *a, **k: pytest.fail('Unexpected process launch'))
    monkeypatch.setattr(docker_local.subprocess, 'Popen', lambda *a, **k: pytest.fail('Unexpected process launch'))


def test_constructor_and_default_resolution_do_not_require_installed_docker():
    client = LocalDocker()
    command, environment = client.invocation(['info'])
    assert command == ['docker', '--host', 'unix:///var/run/docker.sock', 'info']
    assert environment['DOCKER_HOST'] == 'unix:///var/run/docker.sock'


@pytest.mark.parametrize('endpoint', ['ssh://remote', 'tcp://127.0.0.1:2375', 'npipe:////./pipe/docker_engine',
                                     'unix://remote/socket', 'unix:///socket?target=remote', 'unix:///socket\x00', 'unix://[bad'])
def test_remote_or_ambiguous_host_is_rejected_without_process(endpoint):
    with pytest.raises(DockerLocalError):
        LocalDocker().invocation(['ps'], {'DOCKER_HOST': endpoint})


def test_named_context_resolution_is_metadata_only_and_wins_over_host(monkeypatch):
    monkeypatch.setenv('DOCKER_CONTEXT', 'studio-local')
    monkeypatch.setenv('DOCKER_HOST', 'ssh://must-not-contact')
    calls = []
    def inspect(command, **kwargs):
        calls.append(command)
        assert command == ['docker', 'context', 'inspect', 'studio-local', '--format', '{{json .Endpoints.docker.Host}}']
        assert kwargs['timeout'] <= 1.5
        return subprocess.CompletedProcess(command, 0, '"unix:///run/user/1000/docker.sock"', '')
    monkeypatch.setattr(docker_local.subprocess, 'run', inspect)
    command, environment = LocalDocker().invocation(['image', 'inspect', 'reviewed-image'])
    assert len(calls) == 1
    assert command[2] == 'unix:///run/user/1000/docker.sock'
    assert 'DOCKER_CONTEXT' not in environment
    assert environment['DOCKER_HOST'] == command[2]


def test_remote_named_context_is_never_contacted(monkeypatch):
    monkeypatch.setenv('DOCKER_CONTEXT', 'remote')
    calls = []
    def inspect(command, **kwargs):
        calls.append(command)
        return subprocess.CompletedProcess(command, 0, '"ssh://remote"', '')
    monkeypatch.setattr(docker_local.subprocess, 'run', inspect)
    with pytest.raises(DockerLocalError, match='remote'):
        LocalDocker().invocation(['create', 'package'])
    assert len(calls) == 1 and calls[0][1:3] == ['context', 'inspect']


def test_context_from_local_configuration_is_resolved(monkeypatch, tmp_path):
    configuration = tmp_path / 'docker-config'
    configuration.mkdir()
    (configuration / 'config.json').write_text(json.dumps({'currentContext': 'rootless'}))
    def inspect(command, **kwargs):
        assert command[3] == 'rootless'
        return subprocess.CompletedProcess(command, 0, '"unix:///run/user/1000/docker.sock"', '')
    monkeypatch.setattr(docker_local.subprocess, 'run', inspect)
    assert LocalDocker().invocation(['info'])[0][2] == 'unix:///run/user/1000/docker.sock'


@pytest.mark.parametrize('configuration', ['invalid JSON', '[]', '{"currentContext":false}'])
def test_invalid_context_configuration_fails_closed(tmp_path, configuration):
    directory = tmp_path / 'docker-config'
    directory.mkdir()
    (directory / 'config.json').write_text(configuration)
    with pytest.raises(DockerLocalError, match='configuration'):
        LocalDocker().invocation(['info'])


def test_hung_context_probe_is_bounded_and_recoverable(monkeypatch):
    monkeypatch.setenv('DOCKER_CONTEXT', 'local-context')
    def timeout(*args, **kwargs):
        assert kwargs['timeout'] == 1.5
        raise subprocess.TimeoutExpired('docker context inspect', 1.5)
    monkeypatch.setattr(docker_local.subprocess, 'run', timeout)
    client = LocalDocker()
    with pytest.raises(DockerLocalError, match='inspected'):
        client.invocation(['info'])
    monkeypatch.delenv('DOCKER_CONTEXT')
    monkeypatch.setenv('DOCKER_HOST', 'unix:///run/recovered.sock')
    assert client.invocation(['info'])[0][2] == 'unix:///run/recovered.sock'


def test_captured_endpoint_survives_context_changes_and_scrubs_builder_overrides(monkeypatch):
    monkeypatch.setenv('DOCKER_HOST', 'unix:///run/first.sock')
    client = LocalDocker()
    client.invocation(['ps'])
    monkeypatch.setenv('DOCKER_HOST', 'ssh://remote')
    monkeypatch.setenv('DOCKER_CONTEXT', 'cloud')
    monkeypatch.setenv('DOCKER_TLS_VERIFY', '1')
    monkeypatch.setenv('DOCKER_CERT_PATH', '/private/certificates')
    monkeypatch.setenv('BUILDX_BUILDER', 'cloud')
    monkeypatch.setenv('BUILDKIT_HOST', 'tcp://remote:1234')
    command, environment = client.invocation(['build', '--provenance=false', '/local/recipe'])
    assert command[:6] == ['docker', '--host', 'unix:///run/first.sock', 'build', '--builder', 'default']
    assert environment['DOCKER_HOST'] == 'unix:///run/first.sock'
    assert not set(environment) & {'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'BUILDX_BUILDER', 'BUILDKIT_HOST'}


def test_tls_default_does_not_silently_select_another_daemon(monkeypatch):
    monkeypatch.setenv('DOCKER_TLS_VERIFY', '1')
    with pytest.raises(DockerLocalError, match='TLS'):
        LocalDocker().invocation(['ps'])


@pytest.mark.parametrize('command', [['--host', 'ssh://remote', 'ps'], ['buildx', 'build', '.'],
                                     ['build', '--builder=cloud', '.'], ['build', '--builder', 'cloud', '.']])
def test_unreviewed_or_custom_builder_commands_are_rejected(command):
    with pytest.raises(DockerLocalError):
        LocalDocker().invocation(command)


def test_runtime_and_setup_share_captured_endpoint_for_commands_and_streams(tmp_path, monkeypatch):
    runtime = Runtime(Store(tmp_path / 'data'), {})
    setup = SetupManager(runtime.store, runtime)
    assert runtime.docker is setup.docker
    monkeypatch.setenv('DOCKER_HOST', 'unix:///run/local.sock')
    calls = []
    def run(command, **kwargs):
        calls.append((command, kwargs))
        return subprocess.CompletedProcess(command, 0, '', '')
    monkeypatch.setattr(runtime_module.subprocess, 'run', run)
    runtime.command(['ps'])
    monkeypatch.setenv('DOCKER_HOST', 'ssh://remote')
    monkeypatch.setenv('DOCKER_CONTEXT', 'remote')
    class Process:
        returncode = 0
        def __init__(self, text): self.stdout = io.StringIO('') if text else io.BytesIO()
        def poll(self): return 0
        def wait(self, timeout=None): return 0
    def popen(command, **kwargs):
        calls.append((command, kwargs))
        return Process(kwargs.get('text', False))
    monkeypatch.setattr(runtime_module.subprocess, 'Popen', popen)
    runtime.stream({'id': 'unused'}, ['start', '-a', 'owned-container'])
    setup.run(['docker', 'pull', 'pinned-image'], None)
    setup.run(['docker', 'build', '/local/recipe'], None)
    assert len(calls) == 4
    assert all(command[:3] == ['docker', '--host', 'unix:///run/local.sock'] for command, _ in calls)
    assert all(kw['env']['DOCKER_HOST'] == 'unix:///run/local.sock' and 'DOCKER_CONTEXT' not in kw['env'] for _, kw in calls)
    assert '--builder' in calls[-1][0]


def test_missing_docker_does_not_prevent_initialization_and_has_readable_failure(tmp_path, monkeypatch):
    runtime = Runtime(Store(tmp_path / 'data'), {})
    setup = SetupManager(runtime.store, runtime)
    def missing(*args, **kwargs): raise FileNotFoundError('docker')
    monkeypatch.setattr(runtime_module.subprocess, 'run', missing)
    monkeypatch.setattr(package_setup.subprocess, 'Popen', missing)
    assert runtime.command(['info']).returncode == 127
    with pytest.raises(SetupFailure, match='unavailable'):
        setup.run(['docker', 'pull', 'package'], None)


def test_remote_context_failure_is_readable_to_runtime_and_setup(tmp_path, monkeypatch):
    runtime = Runtime(Store(tmp_path / 'data'), {})
    setup = SetupManager(runtime.store, runtime)
    monkeypatch.setenv('DOCKER_HOST', 'ssh://remote')
    with pytest.raises(RuntimeFailure, match='remote'):
        runtime.command(['ps'])
    with pytest.raises(SetupFailure, match='remote'):
        setup.run(['docker', 'pull', 'package'], None)


def test_stop_never_treats_inspection_failure_as_released(tmp_path):
    runtime = Runtime(Store(tmp_path), {})
    calls = []
    runtime.command = lambda args, **kw: calls.append(args) or subprocess.CompletedProcess(args, 1, '', 'Cannot connect to Docker')
    with pytest.raises(RuntimeFailure, match='verify'):
        runtime.stop('owned-id')
    assert [args[0] for args in calls] == ['inspect']


@pytest.mark.parametrize('message', ['Error: No such object: owned-id\n', 'error: no such object: owned-id\n'])
def test_stop_accepts_confirmed_missing_container(tmp_path, message):
    runtime = Runtime(Store(tmp_path), {})
    calls = []
    runtime.command = lambda args, **kw: calls.append(args) or subprocess.CompletedProcess(args, 1, '', message)
    runtime.stop('owned-id')
    assert len(calls) == 1


def test_stop_requires_verified_removal_and_does_not_touch_other_owners(tmp_path):
    runtime = Runtime(Store(tmp_path), {})
    calls = []
    def stuck(args, **kw):
        calls.append(args)
        return subprocess.CompletedProcess(args, 0 if args[0] == 'inspect' else 1, runtime.owner if args[0] == 'inspect' else '', 'Removal failed')
    runtime.command = stuck
    with pytest.raises(RuntimeFailure, match='confirm'):
        runtime.stop('owned-id')
    assert [args[0] for args in calls] == ['inspect', 'stop', 'inspect', 'rm', 'inspect']
    calls.clear()
    runtime.command = lambda args, **kw: calls.append(args) or subprocess.CompletedProcess(args, 0, 'another-owner', '')
    runtime.stop('foreign-id')
    assert [args[0] for args in calls] == ['inspect']


def test_stop_confirms_missing_after_owned_removal(tmp_path):
    runtime = Runtime(Store(tmp_path), {})
    removed = False
    calls = []
    def command(args, **kwargs):
        nonlocal removed
        calls.append(args)
        if args[0] == 'rm': removed = True
        if args[0] == 'inspect':
            return subprocess.CompletedProcess(args, 1 if removed else 0, '' if removed else runtime.owner,
                'Error response from daemon: No such container: owned-id' if removed else '')
        return subprocess.CompletedProcess(args, 0, '', '')
    runtime.command = command
    runtime.stop('owned-id')
    assert removed and calls[-1][0] == 'inspect'
