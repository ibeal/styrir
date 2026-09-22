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

echo "==> starting standalone PostgreSQL"
docker compose -f docker-compose.postgres.yml up -d

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

echo "==> starting/restarting the Paperclip host service"
set -a
# shellcheck disable=SC1091
. ./paperclip.env
set +a
paperclipai service restart || paperclipai service start

echo "==> done. Run scripts/posture-check.sh next to verify the running instance."
