#!/bin/sh
# Stop the host Paperclip service and the standalone PostgreSQL container.
#
# Usage: deploy/paperclip/scripts/down.sh

set -eu

cd "$(dirname "$0")/.."

echo "==> stopping the Paperclip host service"
paperclipai service stop || true

echo "==> stopping standalone PostgreSQL"
docker compose -f docker-compose.postgres.yml down
