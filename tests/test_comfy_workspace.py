"""CPU-only editor lifecycle and trust boundaries without a Docker daemon."""
import importlib.util
import asyncio
import io
import json
from pathlib import Path
import subprocess
import threading
import sys
from types import SimpleNamespace

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import httpx
from PIL import Image
import pytest

from studio.comfy_workspace import ComfyWorkspace, HOSTS, LABEL, SESSION_LABEL, proxy_path
from studio.runtime import RuntimeFailure
from studio.store import Store


CONTAINER = 'a' * 64


class FakeRuntime:
    config = {}
    owner = 'test-owner'

    def __init__(self):
        self.commands = []
        self.labels = {}
        self.running = False
        self.wrong_image = False
        self.fail_start = False
        self.missing_images = set()

    def command(self, args, **kwargs):
        self.commands.append(args)
        result = ''
        code = 0
        if args[:2] == ['image', 'inspect']:
            result = json.dumps([{'Id': 'sha256:' + '0' * 64 if self.wrong_image else args[-1]}])
            code = int(args[-1] in self.missing_images)
        elif args[0] == 'create':
            self.labels = dict(args[i + 1].split('=', 1) for i, item in enumerate(args) if item == '--label')
            result = CONTAINER
        elif args[0] == 'start':
            self.running = not self.fail_start
            code = int(self.fail_start)
        elif args[0] == 'inspect':
            result = json.dumps([{'Id': CONTAINER, 'Config': {'Labels': self.labels},
                                  'State': {'Running': self.running},
                                  'NetworkSettings': {'Ports': {'8188/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '18991'}]}}}])
        elif args[0] == 'rm':
            self.running = False
        elif args[0] == 'logs':
            result = 'Synthetic editor startup failure.'
        else:
            pytest.fail(f'Unexpected Docker call: {args}')
        return subprocess.CompletedProcess(args, code, result, '')


@pytest.fixture
def workspace(tmp_path):
    manager = ComfyWorkspace(Store(tmp_path / 'data'), FakeRuntime(), 'secret', {'testserver'})
    manager._wait_ready = lambda session: None
    yield manager
    manager.controller.close()


def start(workspace, package='wan'):
    project = workspace.store.create_project()
    return workspace.start(package, project['id'])


def client(workspace):
    app = FastAPI()
    app.include_router(workspace.router())
    result = TestClient(app)
    result.cookies.set('studio_session', 'secret')
    return result


@pytest.fixture
def smart_workspace(workspace):
    def starter(session):
        package = session['package_id']
        if package == 'flux':
            nodes = [{'id': 1, 'type': 'PaitonFlux2', 'widgets_values': ['Paiton', 'Starter image prompt', 42]}]
        elif package == 'wan':
            nodes = [{'id': 3, 'type': 'PaitonWanTextEncode', 'widgets_values': ['Starter positive']},
                     {'id': 4, 'type': 'PaitonWanTextEncode', 'widgets_values': ['Starter negative']},
                     {'id': 5, 'type': 'PaitonWanInputImage', 'widgets_values': ['(none)']}]
        else:
            nodes = [{'id': 5, 'type': 'MiniMaxH3ImageToVideo', 'widgets_values': ['Starter video prompt', 864, 480]},
                     {'id': 19, 'type': 'PaitonH3InputImage', 'widgets_values': ['(none)']},
                     {'id': 20, 'type': 'PaitonH3InputImage', 'widgets_values': ['(none)']}]
        return {'nodes': nodes, 'links': [], 'version': .4}
    workspace._fetch_starter = starter
    return workspace


def project_image(workspace, project_id):
    content = io.BytesIO()
    Image.new('RGB', (8, 8), 'red').save(content, format='PNG')
    return workspace.store.add_asset(project_id, 'image', 'fox', content.getvalue(), '.png', {})


def test_smart_open_selects_installed_task_host_and_prefills_starter(smart_workspace):
    w = smart_workspace
    project = w.store.create_project()['id']
    session = w.open(project, 'image', prompt='A paper fox')
    assert session['package_id'] == 'flux' and session['task'] == 'image'
    assert w.workflow(session['id'])['nodes'][0]['widgets_values'][1] == 'A paper fox'
    assert w.snapshot()['recommended'] == {'image': 'flux', 'video': 'wan'}
    assert next(p for p in w.snapshot()['packages'] if p['id'] == 'flux')['tasks'] == ['image']


def test_smart_switch_saves_outgoing_graph_before_container_change(smart_workspace):
    w = smart_workspace
    project = w.store.create_project()['id']
    image = w.open(project, 'image')
    graph = w.workflow(image['id'])
    graph['nodes'][0]['widgets_values'][1] = 'My unsaved image edit'
    source = project_image(w, project)
    observed = []
    original = w._stop
    def stop(expected=None):
        if w.active:
            saved = w._workflow_path(project, 'flux', 'image')
            observed.append(json.loads(saved.read_text()))
        return original(expected)
    w._stop = stop
    video = w.open(project, 'video', image['id'], graph, source['id'], 'Animate the fox')
    assert observed[0] == graph
    assert video['id'] != image['id'] and video['package_id'] == 'wan' and video['task'] == 'video'
    assert video['source_applied'] and video['source_filename'] == source['id'] + '.png'
    video_graph = w.workflow(video['id'])
    assert video_graph['nodes'][0]['widgets_values'][0] == 'Animate the fox'
    assert video_graph['nodes'][1]['widgets_values'][0] == 'Starter negative'
    assert video_graph['nodes'][2]['widgets_values'][0] == source['id'] + '.png'
    restored = w.open(project, 'image', video['id'], video_graph, prompt='Never overwrite previous graph')
    assert restored['workflow_source'] == 'saved' and w.workflow(restored['id']) == graph


@pytest.mark.parametrize('condition', ['stale', 'missing_snapshot', 'missing_video', 'foreign_image', 'bad_graph', 'corrupt_destination'])
def test_smart_preflight_never_stops_current_editor_on_invalid_transition(smart_workspace, condition):
    w = smart_workspace
    project = w.store.create_project()['id']
    session = w.open(project, 'image')
    kwargs = {'expected_session_id': session['id'], 'workflow': w.workflow(session['id'])}
    if condition == 'stale':
        kwargs['expected_session_id'] = 'stale'
    elif condition == 'missing_snapshot':
        kwargs.pop('workflow')
    elif condition == 'missing_video':
        w.runtime.missing_images = {HOSTS['wan']['image_id'], HOSTS['h3']['image_id']}
    elif condition == 'foreign_image':
        kwargs['source_id'] = project_image(w, w.store.create_project()['id'])['id']
    elif condition == 'bad_graph':
        kwargs['workflow'] = {'nodes': 'not a graph'}
    else:
        path = w._workflow_path(project, 'wan', 'video')
        path.parent.mkdir(parents=True)
        path.write_text('broken')
    with pytest.raises((ValueError, RuntimeFailure)):
        w.open(project, 'video', **kwargs)
    assert w.active['id'] == session['id']
    assert not any(args[0] == 'rm' for args in w.runtime.commands)


def test_smart_transition_failure_preserves_graph_and_can_retry_original_request(smart_workspace):
    w = smart_workspace
    project = w.store.create_project()['id']
    first = w.open(project, 'image')
    graph = w.workflow(first['id'])
    graph['extra'] = {'test': 'last unsaved edit'}
    w.runtime.fail_start = True
    with pytest.raises(RuntimeFailure):
        w.open(project, 'video', first['id'], graph)
    assert w.active is None
    assert json.loads(w._workflow_path(project, 'flux', 'image').read_text()) == graph
    assert w.snapshot()['pending']['from_session_id'] == first['id']
    w.runtime.fail_start = False
    retried = w.open(project, 'video', first['id'], graph)
    assert retried['task'] == 'video' and w.snapshot()['pending'] is None


def test_smart_reuses_matching_live_container_and_retains_live_graph(smart_workspace):
    w = smart_workspace
    project = w.store.create_project()['id']
    session = w.open(project, 'video')
    graph = w.workflow(session['id'])
    graph['nodes'][0]['widgets_values'][0] = 'Edited in the live canvas'
    again = w.open(project, 'video', session['id'], graph, prompt='Should not overwrite')
    assert again['id'] == session['id'] and w.workflow(session['id']) == graph
    assert sum(args[0] == 'create' for args in w.runtime.commands) == 1


def test_smart_video_falls_back_to_h3_and_supports_compatible_explicit_choice(smart_workspace):
    w = smart_workspace
    project = w.store.create_project()['id']
    w.runtime.missing_images.add(HOSTS['wan']['image_id'])
    session = w.open(project, 'video')
    assert session['package_id'] == 'h3'
    w.stop(session['id'])
    w.runtime.missing_images.clear()
    assert w.open(project, 'video', package_id='h3')['package_id'] == 'h3'
    with pytest.raises(ValueError, match='supports'):
        w.open(project, 'image', w.active['id'], {'nodes': [], 'links': []}, package_id='wan')


@pytest.mark.parametrize('count', [0, 1, 2])
def test_restored_source_handoff_changes_only_one_unambiguous_image_input(smart_workspace, count):
    w = smart_workspace
    project = w.store.create_project()['id']
    session = w.open(project, 'video')
    graph = {'nodes': [{'id': i, 'type': 'LoadImage', 'widgets_values': ['old.png', 'keep']} for i in range(count)],
             'links': [], 'extra': {'canvas': 'preserve'}}
    source = project_image(w, project)
    result = w.open(project, 'video', session['id'], graph, source['id'], prompt='Do not replace user prompts')
    assert result['source_applied'] == (count == 1)
    saved = w.workflow(session['id'])
    assert saved['extra'] == {'canvas': 'preserve'}
    for node in saved['nodes']:
        assert node['widgets_values'] == [source['id'] + '.png' if count == 1 else 'old.png', 'keep']


def test_graph_api_roundtrip_and_stale_session_protection(smart_workspace):
    w = smart_workspace
    project = w.store.create_project()['id']
    browser = client(w)
    session = browser.post('/api/comfy/open', json={'project_id': project, 'task': 'image'}).json()
    graph = browser.get(session['workflow_url']).json()
    graph['extra'] = {'test': 'saved by parent bridge'}
    assert browser.post(session['workflow_url'], json={'workflow': graph}).json()['saved']
    assert browser.get(session['workflow_url']).json() == graph
    w.stop(session['id'])
    assert browser.post(session['workflow_url'], json={'workflow': graph}).status_code == 404


def test_cross_project_transition_requires_snapshot_and_keeps_each_project_graph(smart_workspace):
    w = smart_workspace
    first_project = w.store.create_project()['id']
    other_project = w.store.create_project()['id']
    session = w.open(first_project, 'video')
    graph = w.workflow(session['id'])
    graph['extra'] = {'owner': first_project}
    with pytest.raises(RuntimeFailure, match='Save the open'):
        w.open(other_project, 'video', session['id'])
    switched = w.open(other_project, 'video', session['id'], graph)
    assert switched['project_id'] == other_project and switched['id'] != session['id']
    assert json.loads(w._workflow_path(first_project, 'wan', 'video').read_text()) == graph
    assert 'extra' not in w.workflow(switched['id'])


def test_packaged_starter_uses_fixed_authenticated_local_url(smart_workspace, monkeypatch):
    w = smart_workspace
    session = start(w, 'h3')
    original_client = httpx.Client
    requests = []
    def upstream(request):
        requests.append(request)
        return httpx.Response(200, json={'nodes': [], 'links': []})
    monkeypatch.setattr('studio.comfy_workspace.httpx.Client',
                        lambda **kwargs: original_client(transport=httpx.MockTransport(upstream), **kwargs))
    ComfyWorkspace._fetch_starter(w, w.active)
    assert str(requests[0].url) == 'http://127.0.0.1:18991/api/workflow_templates/paiton_h3/turbo8-studio.json'
    assert requests[0].headers['x-paiton-editor-token'] == w.active['proxy_token']


@pytest.mark.parametrize('path', ['api/extensions', 'extensions'])
def test_bridge_extension_is_injected_under_session_prefix(workspace, monkeypatch, path):
    session = start(workspace)
    original = httpx.AsyncClient
    monkeypatch.setattr('studio.comfy_workspace.httpx.AsyncClient',
                        lambda **kwargs: original(transport=httpx.MockTransport(lambda request: httpx.Response(200,
                            json=['/extensions/paiton_wan_nodes/start.js'])), **kwargs))
    response = client(workspace).get(session['url'] + path)
    assert response.json() == ['/extensions/paiton_wan_nodes/start.js', '/studio-workspace.js']
    bridge = client(workspace).get(session['url'] + 'studio-workspace.js')
    assert bridge.status_code == 200
    assert bridge.content == (Path(__file__).parents[1] / 'web/comfyStudioBridge.js').read_bytes()
    assert 'javascript' in bridge.headers['content-type']


def test_inventory_does_not_launch_or_download(workspace):
    result = workspace.snapshot()
    assert result['available'] and len(result['packages']) == 3
    assert not result['generation_enabled'] and result['active'] is None
    assert all(args[:2] == ['image', 'inspect'] for args in workspace.runtime.commands)


def test_reject_unknown_package_or_moved_image_before_launch(workspace):
    project = workspace.store.create_project()
    with pytest.raises(ValueError):
        workspace.start('ghcr.io/example/evil', project['id'])
    workspace.runtime.wrong_image = True
    with pytest.raises(RuntimeFailure, match='not installed'):
        workspace.start('wan', project['id'])
    assert not any(args[0] == 'create' for args in workspace.runtime.commands)


def test_start_is_cpu_only_owned_private_and_project_persistent(workspace):
    session = start(workspace)
    args = next(args for args in workspace.runtime.commands if args[0] == 'create')
    assert args[args.index('--publish') + 1] == '127.0.0.1::8188'
    assert args[args.index('--pull') + 1] == 'never'
    assert '--cpu' in args and '--disable-api-nodes' in args
    assert not any('device' in item or '/dev/' in item or '/weights' in item for item in args)
    assert sum(item == '--mount' for item in args) == 2
    assert workspace.runtime.labels[LABEL] == workspace.runtime.owner
    assert workspace.runtime.labels[SESSION_LABEL] == session['id']
    assert session['url'].endswith('/') and session['generation_enabled'] is False
    assert 'proxy_token' not in session and 'container' not in session
    saved = workspace.root / 'projects' / session['project_id'] / 'wan/user/workflows/idea.json'
    saved.parent.mkdir(parents=True)
    saved.write_text('{}')
    workspace.stop()
    assert saved.exists() and not workspace.record.exists()
    reopened = workspace.start('wan', session['project_id'])
    assert reopened['id'] != session['id'] and saved.exists()


def test_same_project_package_reuses_session_and_concurrent_start(workspace):
    project = workspace.store.create_project()
    results = []
    threads = [threading.Thread(target=lambda: results.append(workspace.start('wan', project['id']))) for _ in range(3)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert len({result['id'] for result in results}) == 1
    assert sum(args[0] == 'create' for args in workspace.runtime.commands) == 1


def test_failed_start_cleans_up_own_container(workspace):
    workspace.runtime.fail_start = True
    with pytest.raises(RuntimeFailure, match='could not start'):
        start(workspace)
    assert workspace.active is None and not workspace.record.exists()
    assert ['rm', '--volumes', '--force', CONTAINER] in workspace.runtime.commands
    assert (workspace.root / 'last-error.log').read_text() == 'Synthetic editor startup failure.'


def test_switch_requires_explicit_close_and_stopped_editor_is_reported(workspace):
    session = start(workspace)
    with pytest.raises(RuntimeFailure, match='close the current'):
        workspace.start('h3', session['project_id'])
    workspace.runtime.running = False
    assert workspace.snapshot()['active']['status'] == 'unavailable'
    with pytest.raises(RuntimeFailure, match='has stopped'):
        workspace.start('wan', session['project_id'])


def test_cannot_remove_foreign_container(workspace):
    start(workspace)
    workspace.runtime.labels[LABEL] = 'another-owner'
    with pytest.raises(RuntimeFailure, match='not owned'):
        workspace.stop()
    assert not any(args[0] == 'rm' for args in workspace.runtime.commands)


def test_stale_tab_cannot_stop_a_different_session(workspace):
    first = start(workspace)
    workspace.stop(first['id'])
    second = workspace.start('h3', first['project_id'])
    count = sum(args[0] == 'rm' for args in workspace.runtime.commands)
    with pytest.raises(RuntimeFailure, match='changed in another window'):
        workspace.stop(first['id'])
    assert workspace.active['id'] == second['id']
    assert sum(args[0] == 'rm' for args in workspace.runtime.commands) == count
    assert client(workspace).post('/api/comfy/stop', json={}).status_code == 422


def test_stale_owned_record_is_cleaned_before_start(workspace):
    first = start(workspace)
    workspace.controller.close()  # Simulate OS releasing the crashed process's lease.
    replacement = ComfyWorkspace(workspace.store, workspace.runtime, 'secret', {'testserver'})
    replacement._wait_ready = lambda session: None
    replacement.start('h3', first['project_id'])
    assert ['rm', '--volumes', '--force', CONTAINER] in workspace.runtime.commands
    replacement.close()


def test_second_controller_cannot_take_over_live_editor(workspace):
    first = start(workspace)
    replacement = ComfyWorkspace(workspace.store, workspace.runtime, 'secret', {'testserver'})
    replacement._wait_ready = lambda session: None
    with pytest.raises(RuntimeFailure, match='Another Studio process'):
        replacement.start('h3', first['project_id'])
    assert not any(args[0] == 'rm' for args in workspace.runtime.commands)
    with pytest.raises(RuntimeFailure, match='Another Studio process'):
        replacement.stop(first['id'])
    workspace.stop(first['id'])
    replacement.start('h3', first['project_id'])
    replacement.close()


@pytest.mark.parametrize('path', ['prompt', 'api/prompt', 'api/free', 'internal/models/download', 'manager/install'])
def test_proxy_rejects_execution_and_other_unneeded_writes(workspace, path):
    session = start(workspace)
    response = client(workspace).post(session['url'] + path, json={})
    assert response.status_code == 403
    if path in ('prompt', 'api/prompt'):
        error = response.json()
        assert error['error']['type'] == 'studio_editor_only'
        assert 'Generation is paused' in error['error']['message']
        assert error['error']['details'] == error['error']['message']
        assert error['error']['extra_info'] == {} and error['node_errors'] == {}


@pytest.mark.parametrize('headers,cookie,status', [
    ({}, False, 401), ({'origin': 'https://foreign.example'}, True, 403),
    ({'host': 'foreign.example'}, True, 403), ({'sec-fetch-site': 'cross-site'}, True, 403)])
def test_proxy_authorization(workspace, headers, cookie, status):
    session = start(workspace)
    browser = client(workspace)
    if not cookie:
        browser.cookies.clear()
    assert browser.get(session['url'], headers=headers).status_code == status


def test_closed_session_and_unauthorized_websocket(workspace):
    session = start(workspace)
    browser = client(workspace)
    browser.cookies.clear()
    from starlette.websockets import WebSocketDisconnect
    with pytest.raises(WebSocketDisconnect):
        with browser.websocket_connect(session['url'] + 'ws'):
            pass
    workspace.stop()
    assert client(workspace).get(session['url']).status_code == 404


@pytest.mark.parametrize('path', ['../prompt', '%2e%2e/prompt', '%252e%252e/prompt', 'a\\b', 'a\x00b'])
def test_proxy_paths_reject_traversal(path):
    with pytest.raises(HTTPException):
        proxy_path(path)


def test_only_project_images_are_copied(workspace):
    session = start(workspace)
    content = io.BytesIO()
    Image.new('RGB', (8, 8), 'red').save(content, format='PNG')
    asset = workspace.store.add_asset(session['project_id'], 'image', 'fox', content.getvalue(), '.png', {})
    copied = workspace.add_image(session['id'], asset['id'])
    assert copied['filename'] == asset['id'] + '.png'
    assert (workspace.root / 'projects' / session['project_id'] / 'wan/input' / copied['filename']).read_bytes() == content.getvalue()
    other = workspace.store.create_project()
    foreign = workspace.store.add_asset(other['id'], 'image', 'private', content.getvalue(), '.png', {})
    with pytest.raises(ValueError, match='not found in this project'):
        workspace.add_image(session['id'], foreign['id'])


def test_direct_container_requests_require_private_token_and_cannot_execute(monkeypatch):
    spec = importlib.util.spec_from_file_location('comfy_editor', Path(__file__).parents[1] / 'scripts/comfy_editor.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    class FakeApplication:
        def __init__(self):
            self.middlewares = []
    web = SimpleNamespace(Application=FakeApplication, middleware=lambda function: function,
                          json_response=lambda value, status: SimpleNamespace(status=status, data=value))
    monkeypatch.setitem(sys.modules, 'aiohttp', SimpleNamespace(web=web))
    monkeypatch.setenv('PAITON_EDITOR_TOKEN', 'private')
    monkeypatch.setattr(module.os, 'chdir', lambda path: None)
    monkeypatch.setattr(module.sys, 'path', list(sys.path))
    monkeypatch.setattr(module.sys, 'argv', ['comfy_editor.py', '--cpu'])
    created = []
    monkeypatch.setattr(module.runpy, 'run_path', lambda *args, **kwargs: created.append(FakeApplication()))
    module.main()
    guard = created[0].middlewares[0]
    calls = []
    async def handler(request):
        calls.append(request.path)
        return SimpleNamespace(status=200)
    for path in ('/prompt', '/api/prompt'):
        request = SimpleNamespace(path=path, method='POST', headers={'x-paiton-editor-token': 'private'})
        assert asyncio.run(guard(request, handler)).status == 403
    request = SimpleNamespace(path='/object_info', method='GET', headers={})
    assert asyncio.run(guard(request, handler)).status == 403
    request = SimpleNamespace(path='/api/userdata/workflows%2Fexample.json', method='POST', headers={'x-paiton-editor-token': 'private'})
    assert asyncio.run(guard(request, handler)).status == 200
    assert calls == ['/api/userdata/workflows%2Fexample.json']


def test_proxy_preserves_encoded_workflow_paths_and_drops_browser_credentials(workspace, monkeypatch):
    session = start(workspace)
    original = httpx.AsyncClient
    requests = []
    def upstream(request):
        requests.append(request)
        return httpx.Response(200, json={'saved': True})
    monkeypatch.setattr('studio.comfy_workspace.httpx.AsyncClient',
                        lambda **kwargs: original(transport=httpx.MockTransport(upstream), **kwargs))
    response = client(workspace).post(session['url'] + 'api/userdata/workflows%2Fexample.json?overwrite=true',
                                       headers={'authorization': 'Bearer browser-private', 'x-studio-token': 'secret'},
                                       json={'nodes': []})
    assert response.status_code == 200
    assert requests[0].url.raw_path == b'/api/userdata/workflows%2Fexample.json?overwrite=true'
    assert requests[0].headers['x-paiton-editor-token'] == workspace.active['proxy_token']
    assert not {'cookie', 'authorization', 'x-studio-token'} & requests[0].headers.keys()


@pytest.mark.parametrize('package', ['wan', 'h3', 'flux'])
def test_proxy_rewrites_paiton_start_template_and_import_urls(workspace, monkeypatch, package):
    session = start(workspace, package)
    original = httpx.AsyncClient
    def upstream(request):
        return httpx.Response(200, content=b'import {app} from "../../../scripts/app.js";\nfetch("/api/workflow_templates/paiton_wan_nodes/base.json")',
                              headers={'content-type': 'text/javascript'})
    monkeypatch.setattr('studio.comfy_workspace.httpx.AsyncClient',
                        lambda **kwargs: original(transport=httpx.MockTransport(upstream), **kwargs))
    response = client(workspace).get(session['url'] + 'extensions/paiton_wan_nodes/start.js')
    assert session['url'] + 'api/workflow_templates/' in response.text
    assert '"' + session['url'] + 'scripts/app.js"' in response.text
    assert '../../../scripts/' not in response.text


def test_editor_policy_supports_bundled_wasm_without_relaxing_studio(tmp_path, monkeypatch):
    from fastapi.responses import HTMLResponse
    from studio.app import create_app
    app = create_app(data=tmp_path, config={}, worker_enabled=False)

    async def editor_response(*args):
        return HTMLResponse('<html>Editor fixture</html>')

    monkeypatch.setattr(app.state.comfy, 'proxy', editor_response)
    with TestClient(app) as browser:
        studio_policy = browser.get('/api/session').headers['content-security-policy']
        editor_policy = browser.get('/comfy/fixture/').headers['content-security-policy']
    assert "connect-src 'self';" in studio_policy
    assert 'unsafe-eval' not in studio_policy
    # Comfy's bundled 3D viewer fetches inline WASM; it needs no remote origin.
    assert "connect-src 'self' data: blob:;" in editor_policy
    assert "frame-ancestors 'self'" in editor_policy
