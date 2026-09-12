#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if [[ ! -x .venv/bin/python ]]; then
  cat >&2 <<'MESSAGE'
Paiton Studio needs its local Python environment first.
From the Paiton Studio folder, run:

  python3 -m venv .venv
  .venv/bin/python -m pip install -r requirements.txt

Then follow the remaining installation steps in README.md and run bash run.sh again.
MESSAGE
  exit 1
fi

# These are controller dependencies only. Checking them never loads an AI model.
if ! .venv/bin/python -c 'import sys; assert sys.version_info >= (3, 11); import uvicorn, fastapi, httpx, multipart, av, PIL, pypdf, mcp, packaging' >/dev/null 2>&1; then
  cat >&2 <<'MESSAGE'
Paiton Studio's Python dependencies are missing or cannot load.
Use Python 3.11 or newer (3.12 is tested), then run:

  .venv/bin/python -m pip install -r requirements.txt

If installation reports an error, see Troubleshooting in README.md before starting Studio again.
MESSAGE
  exit 1
fi

if [[ ! -f dist/index.html || ! -d dist/assets ]]; then
  cat >&2 <<'MESSAGE'
Paiton Studio's interface has not been built yet.
From the Paiton Studio folder, run:

  npm ci
  npm run build

Then run bash run.sh again. These steps need Node.js and npm; see README.md.
MESSAGE
  exit 1
fi

exec .venv/bin/python -m uvicorn studio.app:app --host "${PAITON_STUDIO_HOST:-0.0.0.0}" --port "${PAITON_STUDIO_PORT:-8877}" --no-proxy-headers --no-access-log "$@"
