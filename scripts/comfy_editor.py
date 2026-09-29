"""Run the installed ComfyUI editor without permitting graph execution.

Executed inside the reviewed runtime container, never imported by Studio.
The local port requires a private proxy credential, including for WebSockets.
"""
import os
import runpy
import secrets
import sys


MESSAGE = 'This workspace is for editing workflows. Generation is paused; no models are loaded.'


def write_allowed(path):
    path = path.removeprefix('/api')
    return any(path == prefix or path.startswith(prefix + '/') for prefix in (
        '/settings', '/userdata', '/global_subgraphs', '/users', '/upload/image', '/upload/mask'))


def main():
    from aiohttp import web
    token = os.environ['PAITON_EDITOR_TOKEN']

    @web.middleware
    async def editor_guard(request, handler):
        if not secrets.compare_digest(request.headers.get('x-paiton-editor-token', ''), token):
            return web.json_response({'error': 'Open this workspace through Paiton Studio.'}, status=403)
        if request.method not in ('GET', 'HEAD', 'OPTIONS') and not write_allowed(request.path):
            return web.json_response({'error': {'type': 'studio_editor_only', 'message': MESSAGE,
                'details': MESSAGE, 'extra_info': {}}, 'node_errors': {}}, status=403)
        return await handler(request)

    # Install before Comfy imports: this protects its main and internal apps,
    # both /prompt aliases, and requests made directly to the loopback port.
    original = web.Application.__init__

    def initialize(self, *args, **kwargs):
        original(self, *args, **kwargs)
        self.middlewares.insert(0, editor_guard)

    web.Application.__init__ = initialize
    os.chdir('/opt/comfyui')
    sys.path.insert(0, '/opt/comfyui')
    sys.argv[0] = '/opt/comfyui/main.py'
    runpy.run_path('/opt/comfyui/main.py', run_name='__main__')


if __name__ == '__main__':
    main()
