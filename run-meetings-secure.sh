#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
: "${PAITON_TLS_CERT:?Set PAITON_TLS_CERT to a certificate trusted by the client browser}"
: "${PAITON_TLS_KEY:?Set PAITON_TLS_KEY to its private key}"
exec bash ./run.sh --ssl-certfile "$PAITON_TLS_CERT" --ssl-keyfile "$PAITON_TLS_KEY"
