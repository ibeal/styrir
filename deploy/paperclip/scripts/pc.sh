#!/bin/sh
# Run the paperclipai CLI with this deployment's environment loaded.
#
# Usage: deploy/paperclip/scripts/pc.sh <paperclipai args...>
#   e.g. scripts/pc.sh doctor
#        scripts/pc.sh onboard --bind tailnet --install-service
#        scripts/pc.sh service logs -f
#
# Every paperclipai invocation for this deployment must go through here (or
# otherwise load paperclip.env). Without it the CLI falls back to upstream
# defaults: the embedded PostgreSQL instead of our standalone server,
# telemetry enabled, and no feedback-sharing floor.

set -eu

cd "$(dirname "$0")/.."

if [ ! -f paperclip.env ]; then
  echo "error: paperclip.env is missing. Run scripts/init-env.sh first." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
. ./paperclip.env
set +a

exec paperclipai "$@"
