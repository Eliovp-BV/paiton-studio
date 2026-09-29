"""Disposable browser-test API: synthetic hardware/assets, no execution workers.

Only the test runner invokes this file. Runtime and setup probes are fixtures;
the application has no test-mode bypass. All child process execution is denied.
"""
import copy
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
DATA = Path(os.environ['STUDIO_TEST_DATA']).resolve()
if not DATA.is_relative_to(ROOT / '.local') or DATA == ROOT / '.local':
    raise ValueError('Browser fixtures require an isolated directory under .local.')
os.environ['PAITON_STUDIO_DATA'] = str(DATA)
os.environ['PAITON_STUDIO_CONFIG'] = str(DATA / 'config.local.json')
DATA.mkdir(parents=True, exist_ok=True)
(DATA / 'config.local.json').write_text('{}\n')


def forbid_execution(event, args):
    if event in ('subprocess.Popen', 'os.system', 'os.exec', 'os.posix_spawn'):
        raise RuntimeError('The browser fixture backend cannot launch processes.')
    if event == 'open' and isinstance(args[0], (str, bytes)):
        name = os.fsdecode(args[0])
        if name == '/dev/kfd' or name.startswith('/dev/dri'):
            raise RuntimeError('The browser fixture backend cannot open GPU devices.')


sys.addaudithook(forbid_execution)

GPU = dict(driver_available=True, supported=True, available=True, gpu_count=1,
           name='AMD Radeon AI PRO R9700', architecture='gfx1201', architectures=['gfx1201'],
           total=32 * 1024**3, used=0, pids=[], message='Synthetic browser fixture; no GPU accessed.',
           utilization_percent=0, temperature_c=None, power_w=None, power_state=None)

from studio import telemetry, network, version
version.git_sha = lambda *a, **k: '0000000'
telemetry.gpu_status = lambda *a, **k: copy.deepcopy(GPU)
network.allowed_authorities = lambda: {
    '127.0.0.1:' + os.environ['PAITON_STUDIO_PORT'], 'localhost:' + os.environ['PAITON_STUDIO_PORT']}

from studio.runtime import Runtime, RuntimeFailure
from studio.setup import SetupManager
from studio.system_info import SystemInfo
from studio.comfy_workspace import ComfyWorkspace

Runtime.preflight = lambda self, request, *, verify_content=True: 'synthetic-browser-image'
Runtime.pin_request = lambda self, request: request
Runtime.command = lambda *a, **k: (_ for _ in ()).throw(RuntimeFailure('Docker is forbidden in browser fixtures.'))
ComfyWorkspace.close = lambda self: None
SetupManager._system = lambda self: dict(
    ready=True, can_download=True, docker=True, driver=True, supported_gpu=True,
    gpu=copy.deepcopy(GPU), disk_free_bytes=500 * 1024**3, docker_disk_free_bytes=500 * 1024**3,
    checks=[], message='Synthetic browser fixture; downloads are not executed.')

HOST = dict(
    sampled_at='2026-01-01T00:00:00Z',
    platform=dict(system='Linux', machine='x86_64', release='fixture', distribution='Fixture Linux',
                  distribution_id='ubuntu', distribution_version='24.04'),
    gpu=GPU, gpus=[], driver=dict(name='amdgpu', version='fixture'),
    docker=dict(available=True, local_daemon=True, client_version='fixture', server_version='fixture'),
    device_access=dict(kfd_exists=True, kfd_read_write=True, inaccessible_render_nodes=[]),
    memory=dict(total_bytes=64 * 1024**3, available_bytes=48 * 1024**3),
    storage=dict(data=dict(state='known', free_bytes=500 * 1024**3),
                 docker=dict(state='known', free_bytes=500 * 1024**3)),
    python=dict(version='fixture'), rocm=dict(version=None))
SystemInfo.snapshot = lambda *a, **k: copy.deepcopy(HOST)

from studio.app import create_app
from PIL import Image
import uvicorn

app = create_app(data=DATA, config={}, worker_enabled=False)
store = app.state.store
project = store.create_project('Browser fixture')
image_path = DATA / 'fixture.png'
Image.new('RGB', (1024, 576), (38, 62, 80)).save(image_path)
store.add_asset(project['id'], 'image', 'Synthetic landscape', image_path.read_bytes(), '.png',
                dict(width=1024, height=576, source='synthetic browser fixture'))

# Metadata is private and belongs to this suite's temporary directory.
(DATA / 'fixture.json').write_text(json.dumps(dict(project=project['id'], image=str(image_path))))
uvicorn.run(app, host='127.0.0.1', port=int(os.environ['STUDIO_TEST_BACKEND_PORT']),
            log_level='warning', access_log=False, proxy_headers=False)
