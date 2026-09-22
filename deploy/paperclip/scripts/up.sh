#!/bin/sh
# Bring up the standalone PostgreSQL container, then the host Paperclip
# service, with the locked-down configuration in this directory.
#
# Usage: deploy/paperclip/scripts/up.sh
#
# Preconditions (see ../README.md):
#   - Docker Desktop is running.
#   - deploy/paperclip/postgres.env and deploy/paperclip/paperclip.env exist
#     (copied from their .example files and filled in).
#   - deploy/paperclip/VERSION has been filled in with a real pinned version
#     after the first `paperclipai install`.
#   - paperclipai is installed (see README.md "Bring-up, step by step").

set -eu

cd "$(dirname "$0")/.."

for f in postgres.env paperclip.env; do
  if [ ! -f "$f" ]; then
    echo "error: $f is missing. Copy $f.example to $f and fill in real values." >&2
    exit 1
  fi
done

# shellcheck disable=SC1091
. ./VERSION
if [ "${PAPERCLIP_VERSION:-}" = "UNPINNED-FILL-IN-DURING-FIRST-BRING-UP" ] || [ -z "${PAPERCLIP_VERSION:-}" ]; then
  echo "error: deploy/paperclip/VERSION has not been pinned yet. See README.md." >&2
  exit 1
fi

# --env-file, not just env_file: `env_file` in the compose file supplies the
# container's environment but is not read for ${...} interpolation, so
# POSTGRES_HOST_PORT would silently fall back to its default without this.
echo "==> starting standalone PostgreSQL"
docker compose --env-file postgres.env -f docker-compose.postgres.yml up -d

echo "==> waiting for PostgreSQL healthcheck"
for _ in $(seq 1 30); do
  status="$(docker inspect -f '{{.State.Health.Status}}' paperclip-postgres 2>/dev/null || echo starting)"
  if [ "$status" = "healthy" ]; then
    break
  fi
  sleep 2
done
if [ "$status" != "healthy" ]; then
  echo "error: paperclip-postgres did not become healthy in time" >&2
  exit 1
fi

# Supervision of the Paperclip process belongs to the home-manager launchd
# agent (dotfiles), which invokes scripts/service-run.sh. This script only
# kicks it; it never installs or patches a plist.
service_label="ing.paperclip.paperclipai"
if launchctl print "gui/$(id -u)/${service_label}" >/dev/null 2>&1; then
  echo "==> restarting the Paperclip launchd agent"
  launchctl kickstart -k "gui/$(id -u)/${service_label}"
else
  echo "==> no Paperclip launchd agent is installed."
  echo "    Apply the home-manager configuration that declares it, or for a"
  echo "    foreground instance run: sh scripts/service-run.sh"
fi

echo "==> done. Verify with: node posture/posture-check.mjs (see README.md)."
