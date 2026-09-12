"""Linux entrypoint guidance and argument contracts, without starting a server."""
import json
import os
from pathlib import Path
import shutil
import subprocess

import pytest


ROOT = Path(__file__).resolve().parents[1]
pytestmark = pytest.mark.skipif(shutil.which('bash') is None, reason='Linux shell launcher needs Bash')


def workspace(tmp_path, *, python=True, dependencies=True, built=True):
    # A path with spaces also exercises source-ZIP installations outside a shell
    # user's default working directory. The shim records argv, never starts GPU work.
    root = tmp_path / 'Paiton Studio'
    root.mkdir()
    for name in ('run.sh', 'run-meetings-secure.sh'):
        shutil.copy2(ROOT / name, root / name)
    if python:
        interpreter = root / '.venv/bin/python'
        interpreter.parent.mkdir(parents=True)
        interpreter.write_text(
            '#!/usr/bin/env python3\n'
            'import json, pathlib, sys\n'
            f'if sys.argv[1:2] == ["-c"]: sys.exit({0 if dependencies else 1})\n'
            'pathlib.Path("launch-argv.json").write_text(json.dumps(sys.argv[1:]))\n'
        )
        interpreter.chmod(0o755)
    if built:
        (root / 'dist/assets').mkdir(parents=True)
        (root / 'dist/index.html').write_text('<html></html>')
    return root


def launch(root, *, secure=False, extra_env=None):
    env = {key: value for key, value in os.environ.items() if not key.startswith(('PAITON_STUDIO_', 'PAITON_TLS_'))}
    env.update(extra_env or {})
    return subprocess.run(
        ['bash', str(root / ('run-meetings-secure.sh' if secure else 'run.sh'))],
        cwd=root.parent, env=env, capture_output=True, text=True, timeout=10,
    )


@pytest.mark.parametrize(('options', 'message'), [
    ({'python': False}, 'python3 -m venv .venv'),
    ({'dependencies': False}, '.venv/bin/python -m pip install -r requirements.txt'),
    ({'built': False}, 'npm run build'),
])
def test_missing_setup_has_actionable_instructions_and_does_not_start(tmp_path, options, message):
    root = workspace(tmp_path, **options)
    result = launch(root)
    assert result.returncode == 1
    assert message in result.stderr and 'README.md' in result.stderr
    assert not (root / 'launch-argv.json').exists()


def test_normal_launch_keeps_lan_defaults_and_security_flags(tmp_path):
    root = workspace(tmp_path)
    assert launch(root).returncode == 0
    assert json.loads((root / 'launch-argv.json').read_text()) == [
        '-m', 'uvicorn', 'studio.app:app', '--host', '0.0.0.0', '--port', '8877',
        '--no-proxy-headers', '--no-access-log',
    ]


def test_secure_launch_shares_preflight_and_preserves_quoted_options(tmp_path):
    root = workspace(tmp_path, built=False)
    env = {'PAITON_STUDIO_HOST': '127.0.0.1', 'PAITON_STUDIO_PORT': '8899',
           'PAITON_TLS_CERT': '/host certificates/studio.pem', 'PAITON_TLS_KEY': '/host certificates/private.key'}
    result = launch(root, secure=True, extra_env=env)
    assert result.returncode == 1 and 'npm run build' in result.stderr
    (root / 'dist/assets').mkdir(parents=True)
    (root / 'dist/index.html').write_text('<html></html>')
    assert launch(root, secure=True, extra_env=env).returncode == 0
    assert json.loads((root / 'launch-argv.json').read_text()) == [
        '-m', 'uvicorn', 'studio.app:app', '--host', '127.0.0.1', '--port', '8899',
        '--no-proxy-headers', '--no-access-log', '--ssl-certfile', env['PAITON_TLS_CERT'],
        '--ssl-keyfile', env['PAITON_TLS_KEY'],
    ]
