"""A project-scoped, CPU-only ComfyUI editor using reviewed local images.

Generation is intentionally disabled at both the proxy and container boundary.
No model paths, devices, host credentials or inference runtime are mounted.
"""
import asyncio
import json
import os
import re
import secrets
import shutil
import sys
import threading
import time
from urllib.parse import quote, unquote
from typing import Literal

import httpx
from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, Response
from PIL import Image
from pydantic import BaseModel, ConfigDict, Field
from starlette.concurrency import run_in_threadpool
from websockets.asyncio.client import connect
from websockets.exceptions import WebSocketException

from .alternative_models import WAN_IMAGE_ID
from .runtime import ROOT, RuntimeFailure
from .resources import Lease
from .store import atomic, safe_path

LABEL = 'dev.paiton.studio.comfy-owner'
SESSION_LABEL = 'dev.paiton.studio.comfy-session'
MESSAGE = 'Edit and save workflows here. Generation is paused; no models are loaded.'
MAX_BODY = 32 * 1024 * 1024
MAX_WORKFLOW = 5 * 1024 * 1024
HOSTS = {
    'wan': {'name': 'Wan / FastWan', 'config_key': 'wan_image', 'frontend_version': '1.51.10',
            'image_id': WAN_IMAGE_ID, 'templates': ['base', 'fast'], 'tasks': ['video'],
            'starter': '/api/workflow_templates/paiton_wan_nodes/base.json',
            'prompt_node': '3', 'prompt_index': 0, 'input_node': '5'},
    'h3': {'name': 'MiniMax H3', 'config_key': 'h3_image', 'frontend_version': '1.51.10',
           'image_id': 'sha256:4e6faf68c2c32a2a8ae68672c2e03d1cf9db180ab19335a4716f3b8657d2ea61',
           'templates': ['turbo8-studio', 'turbo4-studio'], 'tasks': ['video'],
           'starter': '/api/workflow_templates/paiton_h3/turbo8-studio.json',
           'prompt_node': '5', 'prompt_index': 0, 'input_node': '19'},
    'flux': {'name': 'FLUX.2 klein', 'config_key': 'comfy_flux_image', 'frontend_version': '1.49.6',
             'image_id': 'sha256:b00940f1ee01ce4061b392395458aa0a3a48c51dad69794e16a5f24b8b20add3',
             'templates': ['Generate'], 'tasks': ['image'],
             'starter': '/api/workflow_templates/paiton_flux2/Generate.json',
             'prompt_node': '1', 'prompt_index': 1},
}


class StartInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    package_id: str = Field(max_length=32)
    project_id: str = Field(max_length=64)


class ImageInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    asset_id: str = Field(min_length=1, max_length=64)


class StopInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    session_id: str = Field(min_length=1, max_length=64)


class OpenInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    project_id: str = Field(min_length=1, max_length=64)
    task: Literal['image', 'video']
    package_id: str | None = Field(default=None, min_length=1, max_length=32)
    expected_session_id: str | None = Field(default=None, min_length=1, max_length=64)
    workflow: dict | None = None
    source_id: str | None = Field(default=None, min_length=1, max_length=64)
    prompt: str = Field(default='', max_length=2500)


class WorkflowInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    workflow: dict


def validate_workflow(graph):
    if not isinstance(graph, dict) or not isinstance(graph.get('nodes'), list) or not isinstance(graph.get('links', []), list):
        raise ValueError('The editor did not provide a valid workflow. Keep it open and retry.')
    if len(graph['nodes']) > 5000 or len(graph.get('links', [])) > 20000:
        raise ValueError('This workflow is too large to transfer between workspaces.')
    if any(not isinstance(node, dict) or not isinstance(node.get('type'), str) for node in graph['nodes']):
        raise ValueError('The editor workflow contains an invalid node.')
    try:
        encoded = json.dumps(graph, allow_nan=False).encode()
    except (ValueError, TypeError):
        raise ValueError('The editor workflow contains unsupported values.') from None
    if len(encoded) > MAX_WORKFLOW:
        raise ValueError('Choose a workflow smaller than 5 MB.')
    return encoded


def write_allowed(path):
    path = path.removeprefix('/api')
    return any(path == prefix or path.startswith(prefix + '/') for prefix in (
        '/settings', '/userdata', '/global_subgraphs', '/users', '/upload/image', '/upload/mask'))


def proxy_path(path):
    """Reject ambiguous paths before URL construction or write authorization."""
    for _ in range(3):
        decoded = unquote(path)
        if decoded == path:
            break
        path = decoded
    if '\\' in path or any(part in ('.', '..') for part in path.split('/')) or any(ord(c) < 32 for c in path):
        raise HTTPException(400, 'Invalid workspace path.')
    return '/' + path.lstrip('/')


class DockerEditorAdapter:
    """Linux launch details stay isolated from project/proxy behavior."""
    def __init__(self, runtime):
        self.runtime = runtime

    def create(self, session, directory, owner):
        if sys.platform != 'linux':
            raise RuntimeFailure('The managed ComfyUI editor currently requires local Docker on Linux.')
        script = ROOT / 'scripts/comfy_editor.py'
        if any(',' in str(path) for path in (directory, script)):
            raise RuntimeFailure('Move Studio data to a path without commas to open ComfyUI.')
        args = ['create', '--pull', 'never', '--name', 'paiton-studio-comfy-' + session['id'],
                '--label', LABEL + '=' + owner, '--label', SESSION_LABEL + '=' + session['id'],
                '--publish', '127.0.0.1::8188', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
                '--no-healthcheck',
                '--pids-limit', '512', '--memory', '4g', '--cpus', '2',
                '--user', f'{os.getuid()}:{os.getgid()}',
                '--mount', f'type=bind,source={directory},target=/session',
                '--mount', f'type=bind,source={script},target=/studio/comfy_editor.py,readonly',
                '--env', 'PAITON_EDITOR_TOKEN=' + session['proxy_token'],
                '--env', 'HF_HUB_OFFLINE=1', '--env', 'TRANSFORMERS_OFFLINE=1',
                '--env', 'HIP_VISIBLE_DEVICES=', '--env', 'ROCR_VISIBLE_DEVICES=', '--env', 'CUDA_VISIBLE_DEVICES=',
                '--env', 'HF_HUB_DISABLE_TELEMETRY=1', '--env', 'HOME=/session',
                '--env', 'XDG_CACHE_HOME=/session/cache', '--env', 'PYTHONDONTWRITEBYTECODE=1',
                '--env', 'HF_HOME=/session/cache/huggingface', '--env', 'HF_HUB_CACHE=/session/cache/huggingface/hub',
                '--env', 'TORCHINDUCTOR_CACHE_DIR=/session/cache/inductor', '--env', 'TRITON_CACHE_DIR=/session/cache/triton',
                '--entrypoint', 'python3', '--workdir', '/opt/comfyui', session['image_id'],
                '/studio/comfy_editor.py', '--cpu', '--disable-api-nodes',
                '--base-directory', '/session', '--extra-model-paths-config', '/session/nodes.yaml',
                '--listen', '0.0.0.0', '--port', '8188', '--input-directory', '/session/input',
                '--output-directory', '/session/output', '--temp-directory', '/session/temp',
                '--user-directory', '/session/user', '--cache-none', '--preview-method', 'none']
        result = self.runtime.command(args, timeout=30)
        if result.returncode or not re.fullmatch(r'[0-9a-f]{64}', result.stdout.strip()):
            raise RuntimeFailure('ComfyUI could not create its local editor container. Check Docker and retry.')
        return result.stdout.strip()


class ComfyWorkspace:
    def __init__(self, store, runtime, token, authorities):
        self.store, self.runtime = store, runtime
        self.token, self.authorities = token, authorities
        self.lock = threading.RLock()
        self.controller = Lease(store.root / 'comfy-controller.lock')
        self.active = None
        self.adapter = DockerEditorAdapter(runtime)
        self.root = store.root / 'comfy'
        self.record = self.root / 'active.json'
        self.transition_record = self.root / 'transition.json'

    def _image(self, package):
        spec = HOSTS[package]
        # Tags and labels cannot authorize execution. Resolve a configured name
        # only when its immutable ID matches this reviewed editor contract.
        reference = self.runtime.config.get(spec['config_key']) or spec['image_id']
        if not isinstance(reference, str) or reference.startswith('-'):
            return None
        result = self.runtime.command(['image', 'inspect', '--', reference], timeout=10)
        if result.returncode:
            return None
        try:
            identity = json.loads(result.stdout)[0]['Id']
        except (ValueError, IndexError, KeyError, TypeError):
            return None
        return identity if identity == spec['image_id'] else None

    @staticmethod
    def _public(session):
        if not session:
            return None
        result = {key: session[key] for key in ('id', 'package_id', 'project_id', 'url', 'mode',
                                              'generation_enabled', 'templates', 'status', 'task')}
        result['workflow_url'] = f"/api/comfy/{session['id']}/workflow"
        for key in ('source_filename', 'source_applied', 'workflow_source'):
            if key in session:
                result[key] = session[key]
        return result

    def snapshot(self):
        packages = []
        available = sys.platform == 'linux'
        for identity, spec in HOSTS.items():
            try:
                image = self._image(identity) if available else None
            except RuntimeFailure:
                image = None
            packages.append({'id': identity, 'name': spec['name'], 'installed': bool(image),
                             'image_id': image, 'frontend_version': spec['frontend_version'],
                             'templates': spec['templates'], 'tasks': spec['tasks']})
        with self.lock:
            if self.active:
                try:
                    details = self._owned(self.active)
                    if not details or not details.get('State', {}).get('Running'):
                        self.active['status'] = 'unavailable'
                except RuntimeFailure:
                    self.active['status'] = 'unavailable'
            active = self._public(self.active)
        recommended = {task: next((package['id'] for package in packages if package['installed'] and task in package['tasks']), None)
                       for task in ('image', 'video')}
        pending = None
        try:
            pending = json.loads(self.transition_record.read_text())
        except (FileNotFoundError, ValueError):
            pass
        return {'packages': packages, 'active': active, 'generation_enabled': False, 'message': MESSAGE,
                'recommended': recommended, 'pending': pending,
                'available': available and any(p['installed'] for p in packages)}

    def _owned(self, session):
        identity = session.get('container', '')
        if not re.fullmatch(r'[0-9a-f]{64}', identity):
            raise RuntimeFailure('The saved editor container identity is invalid.')
        result = self.runtime.command(['inspect', '--', identity], timeout=10)
        if result.returncode:
            return None
        try:
            item = json.loads(result.stdout)[0]
            labels = item['Config'].get('Labels') or {}
            if item['Id'] != identity or labels.get(LABEL) != self.runtime.owner or labels.get(SESSION_LABEL) != session['id']:
                raise ValueError()
        except (ValueError, KeyError, IndexError, TypeError):
            raise RuntimeFailure('This container is not owned by this Studio workspace.') from None
        return item

    def _stop(self, expected=None):
        if not self.controller.acquire():
            raise RuntimeFailure('Another Studio process owns the ComfyUI editor for this data directory.')
        session = self.active
        if not session and self.record.exists():
            try:
                session = json.loads(self.record.read_text())
            except (ValueError, OSError):
                raise RuntimeFailure('The saved ComfyUI session could not be read.') from None
        if session:
            if expected is not None and not secrets.compare_digest(expected, session.get('id', '')):
                raise RuntimeFailure('The ComfyUI workspace changed in another window. Refresh before closing it.')
            if self._owned(session):
                result = self.runtime.command(['rm', '--volumes', '--force', session['container']], timeout=30)
                if result.returncode:
                    raise RuntimeFailure('ComfyUI could not stop. Check Docker and retry.')
            self.record.unlink(missing_ok=True)
        self.active = None

    def stop(self, expected=None):
        with self.lock:
            try:
                self._stop(expected)
            finally:
                if not self.active:
                    self.controller.close()
        return {'stopped': True}

    def close(self):
        with self.lock:
            if self.active:
                self.stop()
            else:
                self.controller.close()

    def _wait_ready(self, session):
        deadline = time.monotonic() + 90
        next_inspect = 0
        with httpx.Client(trust_env=False, timeout=2) as client:
            while time.monotonic() < deadline:
                if time.monotonic() >= next_inspect:
                    details = self._owned(session)
                    if not details or not details.get('State', {}).get('Running'):
                        raise RuntimeFailure('ComfyUI exited before its editor was ready. Check the local editor runtime and retry.')
                    next_inspect = time.monotonic() + 2
                try:
                    response = client.get(f"http://127.0.0.1:{session['port']}/system_stats",
                                          headers={'x-paiton-editor-token': session['proxy_token']})
                    if response.status_code == 200:
                        return
                except httpx.HTTPError:
                    pass
                time.sleep(.25)
        raise RuntimeFailure('ComfyUI did not become ready. Your saved workflows are unchanged; retry opening the editor.')

    def _capture_failure(self, session):
        """Keep bounded local diagnostics before removing the owned container."""
        try:
            if self._owned(session):
                result = self.runtime.command(['logs', '--tail', '160', session['container']], timeout=10)
                content = (result.stdout + result.stderr)[-65536:].replace(session['proxy_token'], '[redacted]')
                atomic(self.root / 'last-error.log', content.encode())
        except (RuntimeFailure, OSError, ValueError):
            pass

    def start(self, package_id, project_id):
        with self.lock:
            try:
                return self._start(package_id, project_id)
            finally:
                if not self.active:
                    self.controller.close()

    def _start(self, package_id, project_id, verified_image=None):
        if package_id not in HOSTS:
            raise ValueError('Choose an installed ComfyUI editor package.')
        self.store.project(project_id)
        with self.lock:
            if self.active:
                if self.active['package_id'] != package_id or self.active['project_id'] != project_id:
                    raise RuntimeFailure('Save your workflows and close the current ComfyUI workspace before opening another.')
                details = self._owned(self.active)
                if not details or not details.get('State', {}).get('Running'):
                    self.active['status'] = 'unavailable'
                    raise RuntimeFailure('ComfyUI has stopped. Close and reopen the workspace; saved workflows remain available.')
                return self._public(self.active)
            image = verified_image or self._image(package_id)
            if image and image != HOSTS[package_id]['image_id']:
                raise RuntimeFailure('The requested editor image does not match the reviewed package.')
            if not image:
                raise RuntimeFailure('This reviewed ComfyUI editor package is not installed. No download was started.')
            self._stop()
            directory = safe_path(self.root, f'projects/{project_id}/{package_id}')
            for name in ('input', 'output', 'temp', 'user', 'cache', 'custom_nodes', 'models'):
                safe_path(directory, name).mkdir(parents=True, exist_ok=True)
            atomic(directory / 'nodes.yaml', b'paiton_editor:\n  base_path: /opt/comfyui\n  custom_nodes: custom_nodes\n')
            identity = secrets.token_hex(16)
            session = dict(id=identity, package_id=package_id, project_id=project_id,
                           image_id=image, proxy_token=secrets.token_urlsafe(32), url=f'/comfy/{identity}/',
                           mode='editing', generation_enabled=False, status='starting', task=HOSTS[package_id]['tasks'][0],
                           templates=HOSTS[package_id]['templates'])
            session['container'] = self.adapter.create(session, directory, self.runtime.owner)
            self.active = session
            try:
                atomic(self.record, json.dumps({'container': session['container'], 'id': identity}).encode())
                result = self.runtime.command(['start', session['container']], timeout=30)
                if result.returncode:
                    raise RuntimeFailure('ComfyUI could not start its editor.')
                details = self._owned(session)
                bindings = details['NetworkSettings']['Ports']['8188/tcp'] if details else None
                if not bindings or len(bindings) != 1 or bindings[0]['HostIp'] != '127.0.0.1':
                    raise RuntimeFailure('ComfyUI did not receive a private loopback port.')
                session['port'] = int(bindings[0]['HostPort'])
                if not 1 <= session['port'] <= 65535:
                    raise RuntimeFailure('Invalid ComfyUI editor port.')
                self._wait_ready(session)
                session['status'] = 'ready'
            except BaseException:
                self._capture_failure(session)
                self._stop()
                raise
            return self._public(session)

    def _workflow_path(self, project_id, package_id, task):
        if package_id not in HOSTS or task not in HOSTS[package_id]['tasks']:
            raise ValueError('This editor package does not support the requested workspace.')
        return safe_path(self.root, f'projects/{project_id}/{package_id}/studio-workflows/{task}.json')

    def _read_workflow(self, path):
        if not path.exists():
            return None
        if path.stat().st_size > MAX_WORKFLOW:
            raise ValueError('The saved workflow is too large. Export it from ComfyUI before switching.')
        try:
            graph = json.loads(path.read_text())
        except (ValueError, OSError):
            raise ValueError('The saved workflow could not be read. Your current editor remains open.') from None
        validate_workflow(graph)
        return graph

    def _fetch_starter(self, session):
        path = HOSTS[session['package_id']]['starter']
        try:
            with httpx.Client(trust_env=False, timeout=15) as client:
                with client.stream('GET', f"http://127.0.0.1:{session['port']}" + path,
                                   headers={'x-paiton-editor-token': session['proxy_token']}) as response:
                    response.raise_for_status()
                    content = bytearray()
                    for chunk in response.iter_bytes():
                        content.extend(chunk)
                        if len(content) > MAX_WORKFLOW:
                            raise ValueError('The packaged starter workflow is too large.')
            graph = json.loads(content)
            validate_workflow(graph)
            return graph
        except (httpx.HTTPError, ValueError):
            raise RuntimeFailure('The editor could not load its packaged starter workflow. Retry opening it; your previous workflow is saved.') from None

    def _prepare_workflow(self, session, saved=None):
        path = self._workflow_path(session['project_id'], session['package_id'], session['task'])
        saved = self._read_workflow(path) if saved is None else saved
        if saved is not None:
            session['workflow_source'] = 'saved'
            if session.get('source_requested'):
                images = [node for node in saved['nodes'] if node.get('type') in
                          ('LoadImage', 'PaitonWanInputImage', 'PaitonH3InputImage')]
                values = images[0].get('widgets_values') if len(images) == 1 else None
                session['source_applied'] = bool(isinstance(values, list) and values)
                if session['source_applied']:
                    values[0] = session['source_filename']
                    atomic(path, validate_workflow(saved))
                session['source_requested'] = False
            return saved
        graph = self._fetch_starter(session)
        spec = HOSTS[session['package_id']]
        for node in graph['nodes']:
            values = node.get('widgets_values')
            if not isinstance(values, list):
                continue
            if str(node.get('id')) == spec['prompt_node'] and session.get('starter_prompt') and len(values) > spec['prompt_index']:
                values[spec['prompt_index']] = session['starter_prompt']
            if str(node.get('id')) == spec.get('input_node') and session.get('source_requested') and values:
                values[0] = session['source_filename']
                session['source_applied'] = True
        atomic(path, validate_workflow(graph))
        session['source_requested'] = False
        session['workflow_source'] = 'starter'
        return graph

    def workflow(self, identity):
        with self.lock:
            self.session(identity)
            return self._prepare_workflow(self.active)

    def save_workflow(self, identity, graph):
        encoded = validate_workflow(graph)
        with self.lock:
            session = self.session(identity)
            path = self._workflow_path(session['project_id'], session['package_id'], session['task'])
            atomic(path, encoded)
        return {'saved': True, 'session_id': identity}

    def open(self, project_id, task, expected_session_id=None, workflow=None, source_id=None, prompt='', package_id=None):
        """Save a confirmed outgoing graph before switching task and runtime."""
        if task not in ('image', 'video'):
            raise ValueError('Choose the Image or Video workspace.')
        self.store.project(project_id)
        if not isinstance(prompt, str) or len(prompt) > 2500:
            raise ValueError('Keep the prompt within 2,500 characters.')
        encoded = validate_workflow(workflow) if workflow is not None else None
        with self.lock:
            try:
                outgoing = self.active
                if outgoing and expected_session_id != outgoing['id']:
                    raise RuntimeFailure('The ComfyUI workspace changed in another window. Refresh before switching.')
                if not outgoing and expected_session_id is not None:
                    try:
                        pending = json.loads(self.transition_record.read_text())
                    except (FileNotFoundError, ValueError):
                        pending = {}
                    if not (pending.get('from_session_id') == expected_session_id and pending.get('project_id') == project_id and pending.get('task') == task):
                        raise RuntimeFailure('The previous ComfyUI session is closed. Refresh before opening another.')
                candidates = [key for key, spec in HOSTS.items() if task in spec['tasks']]
                if package_id is not None:
                    if package_id not in candidates:
                        raise ValueError('Choose an editor package that supports this workspace.')
                    candidates = [package_id]
                elif outgoing and outgoing['project_id'] == project_id and outgoing['package_id'] in candidates:
                    candidates.remove(outgoing['package_id'])
                    candidates.insert(0, outgoing['package_id'])
                package_id, image = None, None
                for candidate in candidates:
                    image = self._image(candidate)
                    if image:
                        package_id = candidate
                        break
                if not package_id:
                    raise RuntimeFailure(f'No reviewed {task} editor package is installed. Your current workspace is unchanged; no download was started.')
                same = bool(outgoing and outgoing['project_id'] == project_id and outgoing['package_id'] == package_id and outgoing['task'] == task)
                if outgoing and not same and encoded is None:
                    raise RuntimeFailure('Save the open editor workflow before switching. Keep the editor open and retry.')
                if outgoing and source_id and encoded is None:
                    raise RuntimeFailure('Save the open editor workflow before sending another image. Keep the editor open and retry.')
                target_path = self._workflow_path(project_id, package_id, task)
                saved = self._read_workflow(target_path)
                source = self._image_source(project_id, source_id) if source_id else None
                if not self.controller.acquire():
                    raise RuntimeFailure('Another Studio process owns the ComfyUI editor for this data directory.')
                if outgoing and encoded is not None:
                    atomic(self._workflow_path(outgoing['project_id'], outgoing['package_id'], outgoing['task']), encoded)
                    if same:
                        saved = workflow
                if source:
                    directory = safe_path(self.root, f'projects/{project_id}/{package_id}/input')
                    directory.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(source[0], safe_path(directory, source[1]))
                transition = {'project_id': project_id, 'task': task, 'package_id': package_id,
                              'source_id': source_id, 'prompt': prompt,
                              'from_session_id': outgoing['id'] if outgoing else expected_session_id}
                atomic(self.transition_record, json.dumps(transition).encode())
                if outgoing and not same:
                    self._stop(outgoing['id'])
                # Keep the transfer request and previous graph durable until
                # the destination and its graph are both ready for the browser.
                self._start(package_id, project_id, verified_image=image)
                self.active['task'] = task
                self.active['starter_prompt'] = prompt
                self.active['source_applied'] = False
                self.active['source_requested'] = bool(source)
                if source:
                    self.active['source_filename'] = source[1]
                self._prepare_workflow(self.active, saved)
                self.transition_record.unlink(missing_ok=True)
                return self._public(self.active)
            finally:
                if not self.active:
                    self.controller.close()

    def session(self, identity):
        with self.lock:
            if not self.active or not secrets.compare_digest(identity, self.active['id']):
                raise HTTPException(404, 'This ComfyUI session is closed. Open it again from Studio.')
            return dict(self.active)

    def authorize(self, connection):
        host = connection.headers.get('host', '').lower()
        origin = connection.headers.get('origin')
        if host not in self.authorities or (origin and origin not in {f'http://{host}', f'https://{host}'}) or connection.headers.get('sec-fetch-site') == 'cross-site':
            raise HTTPException(403, 'Open the ComfyUI workspace from this Studio.')
        valid = (self.browser_authorized(connection) if hasattr(self, 'browser_authorized') else
                 secrets.compare_digest(connection.cookies.get('studio_session', ''), self.token))
        if not valid:
            raise HTTPException(401, 'Open Studio to begin a local session.')

    def add_image(self, identity, asset_id):
        with self.lock:
            session = self.session(identity)
            source, filename = self._image_source(session['project_id'], asset_id)
            target = safe_path(self.root, f"projects/{session['project_id']}/{session['package_id']}/input/{filename}")
            shutil.copyfile(source, target)
        return {'filename': filename, 'message': 'Choose this file in a Load Image node.'}

    def _image_source(self, project_id, asset_id):
        asset = self.store.asset(asset_id, project_id)
        if asset['kind'] != 'image':
            raise ValueError('Choose an image from this project.')
        source = self.store.file(asset)
        if source.stat().st_size > MAX_BODY:
            raise ValueError('Choose an image smaller than 32 MB.')
        with Image.open(source) as picture:
            extension = {'PNG': '.png', 'JPEG': '.jpg', 'WEBP': '.webp'}.get(picture.format)
            picture.verify()
        if not extension:
            raise ValueError('Choose a PNG, JPEG or WebP image.')
        return source, asset['id'] + extension

    async def proxy(self, request, identity, path):
        self.authorize(request)
        session = await run_in_threadpool(self.session, identity)
        path = proxy_path(path)
        if path == '/studio-workspace.js' and request.method in ('GET', 'HEAD'):
            return Response((ROOT / 'web/comfyStudioBridge.js').read_bytes(), media_type='text/javascript')
        if request.method not in ('GET', 'HEAD', 'OPTIONS') and not write_allowed(path):
            if path in ('/prompt', '/api/prompt'):
                return JSONResponse({'error': {'type': 'studio_editor_only', 'message': MESSAGE,
                    'details': MESSAGE, 'extra_info': {}}, 'node_errors': {}}, status_code=403)
            raise HTTPException(403, MESSAGE)
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > MAX_BODY:
                raise HTTPException(413, 'Choose a file smaller than 32 MB.')
        headers = {key: value for key, value in request.headers.items() if key.lower() in {
            'content-type', 'accept', 'range', 'comfy-user', 'if-none-match', 'if-modified-since'}}
        headers['x-paiton-editor-token'] = session['proxy_token']
        headers['accept-encoding'] = 'identity'
        # Preserve encoded slashes in Comfy's single-segment userdata routes:
        # workflows%2Fexample.json must not become two route segments.
        raw_path = request.scope.get('raw_path', b'').decode('ascii', errors='strict')
        raw_prefix = session['url']
        upstream_path = '/' + raw_path[len(raw_prefix):] if raw_path.startswith(raw_prefix) else quote(path, safe='/@:+')
        url = f"http://127.0.0.1:{session['port']}" + upstream_path
        try:
            async with httpx.AsyncClient(trust_env=False, timeout=30) as client:
                async with client.stream(request.method, url, params=request.query_params.multi_items(),
                                         headers=headers, content=bytes(body)) as upstream:
                    chunks, size = [], 0
                    async for chunk in upstream.aiter_bytes():
                        size += len(chunk)
                        if size > 64 * 1024 * 1024:
                            raise HTTPException(502, 'The workspace response was too large.')
                        chunks.append(chunk)
                    content = b''.join(chunks)
                    response_headers = {k: v for k, v in upstream.headers.items() if k.lower() in {
                        'content-type', 'content-range', 'accept-ranges', 'etag'}}
                    if path in ('/extensions', '/api/extensions') and upstream.status_code == 200:
                        try:
                            extensions = json.loads(content)
                            if isinstance(extensions, list) and '/studio-workspace.js' not in extensions:
                                extensions.append('/studio-workspace.js')
                                content = json.dumps(extensions).encode()
                        except (ValueError, TypeError):
                            pass
                    if path.startswith('/extensions/') and path.endswith('/start.js'):
                        # These reviewed Paiton extensions predate prefix hosting.
                        content = content.replace(b'/api/workflow_templates/',
                                                  (session['url'] + 'api/workflow_templates/').encode())
                        # At /extensions/<node>/start.js, three parent segments
                        # relied on the root path clamping at /. Under our
                        # session prefix it escapes the session instead.
                        for delimiter in (b'"', b"'"):
                            content = content.replace(delimiter + b'../../../scripts/',
                                                      delimiter + (session['url'] + 'scripts/').encode())
                    return Response(content, status_code=upstream.status_code, headers=response_headers)
        except httpx.HTTPError:
            raise HTTPException(502, 'ComfyUI is unavailable. Close and reopen the workspace.') from None

    async def websocket(self, socket, identity, path):
        try:
            self.authorize(socket)
            session = await run_in_threadpool(self.session, identity)
            if proxy_path(path) != '/ws':
                raise HTTPException(404)
        except HTTPException:
            await socket.close(code=1008)
            return
        query = ('?' + str(socket.query_params)) if socket.query_params else ''
        close_code = 1000
        try:
            async with connect(f"ws://127.0.0.1:{session['port']}/ws" + query,
                               additional_headers={'x-paiton-editor-token': session['proxy_token']},
                               proxy=None, max_size=MAX_BODY, open_timeout=10) as upstream:
                await socket.accept()

                async def outbound():
                    while True:
                        message = await socket.receive()
                        if message['type'] == 'websocket.disconnect':
                            return
                        await run_in_threadpool(self.authorize, socket)
                        await upstream.send(message.get('text') if message.get('text') is not None else message['bytes'])

                async def inbound():
                    async for message in upstream:
                        await run_in_threadpool(self.authorize, socket)
                        if isinstance(message, bytes):
                            await socket.send_bytes(message)
                        else:
                            await socket.send_text(message)

                async def monitor_authorization():
                    while True:
                        await asyncio.sleep(.5)
                        await run_in_threadpool(self.authorize, socket)

                tasks = {asyncio.create_task(outbound()), asyncio.create_task(inbound()),
                         asyncio.create_task(monitor_authorization())}
                try:
                    done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                    for task in done:
                        task.result()
                finally:
                    for task in tasks:
                        task.cancel()
                    await asyncio.gather(*tasks, return_exceptions=True)
        except HTTPException:
            close_code = 1008
        except (OSError, WebSocketException, WebSocketDisconnect, RuntimeError):
            pass
        finally:
            try:
                await socket.close(code=close_code)
            except (RuntimeError, WebSocketDisconnect, OSError):
                pass

    def router(self):
        router = APIRouter()

        @router.get('/api/comfy')
        def status():
            return self.snapshot()

        @router.post('/api/comfy/start')
        def start(body: StartInput):
            return self.start(body.package_id, body.project_id)

        @router.post('/api/comfy/open')
        def open_workspace(body: OpenInput):
            return self.open(**body.model_dump())

        @router.get('/api/comfy/{session_id}/workflow')
        def workflow(session_id: str):
            return self.workflow(session_id)

        @router.post('/api/comfy/{session_id}/workflow')
        def save_workflow(session_id: str, body: WorkflowInput):
            return self.save_workflow(session_id, body.workflow)

        @router.post('/api/comfy/stop')
        def stop(body: StopInput):
            return self.stop(body.session_id)

        @router.post('/api/comfy/{session_id}/input')
        def add_image(session_id: str, body: ImageInput):
            return self.add_image(session_id, body.asset_id)

        @router.api_route('/comfy/{session_id}/{path:path}', methods=['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'])
        async def proxy(request: Request, session_id: str, path: str):
            return await self.proxy(request, session_id, path)

        @router.websocket('/comfy/{session_id}/{path:path}')
        async def websocket(socket: WebSocket, session_id: str, path: str):
            await self.websocket(socket, session_id, path)

        return router
