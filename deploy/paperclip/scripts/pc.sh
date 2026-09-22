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
#
# Env file location: defaults to paperclip.env next to this script (a
# checkout), but honors PAPERCLIP_ENV_FILE if set, so the flake-packaged copy
# of this same script (paperclip-cli) works from the Nix store with no
# knowledge of this repository's layout. Both paths run identical code.

set -eu

script_dir="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
default_deploy_dir="$(CDPATH='' cd -- "$script_dir/.." && pwd)"
env_file="${PAPERCLIP_ENV_FILE:-$default_deploy_dir/paperclip.env}"

if [ ! -f "$env_file" ]; then
  echo "error: $env_file is missing. Run scripts/init-env.sh first, or set PAPERCLIP_ENV_FILE." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
. "$env_file"
set +a

exec paperclipai "$@"
