#!/bin/sh
# Entry point for the Paperclip LaunchAgent. Installed by
# scripts/install-service.sh, which rewrites the generated plist to call this
# instead of `paperclipai run` directly.
#
# It exists because a launchd agent inherits almost nothing: not the login
# shell's PATH, and not paperclip.env. Without this wrapper the service starts
# with upstream defaults for every env-only setting — most importantly
# PAPERCLIP_SETTING_DEFAULTS and PAPERCLIP_HIDDEN_SETTINGS, which are the
# feedback-trace-sharing floor and have no config.json equivalent. The
# instance would come up looking healthy with that floor silently absent.

set -eu

cd "$(dirname "$0")/.."

set -a
# shellcheck disable=SC1091
. ./paperclip.env
set +a

# launchd's PATH does not include Homebrew, so `tailscale` is not findable and
# Paperclip's tailnet detection fails with "server.bind=tailnet requires a
# detected Tailscale address". Resolve the address here instead of depending on
# the agent's PATH, and re-resolve on every start so a changed tailnet address
# is picked up by a restart rather than pinned into a file.
if [ -z "${PAPERCLIP_TAILNET_BIND_HOST:-}" ]; then
  for tailscale_bin in /opt/homebrew/bin/tailscale /usr/local/bin/tailscale /Applications/Tailscale.app/Contents/MacOS/Tailscale; do
    if [ -x "$tailscale_bin" ]; then
      PAPERCLIP_TAILNET_BIND_HOST="$("$tailscale_bin" ip -4 2>/dev/null | head -1)"
      export PAPERCLIP_TAILNET_BIND_HOST
      break
    fi
  done
fi

if [ -z "${PAPERCLIP_TAILNET_BIND_HOST:-}" ]; then
  echo "error: could not resolve a Tailscale address; refusing to start rather than binding somewhere unintended." >&2
  exit 1
fi

exec paperclipai run --instance "${PAPERCLIP_INSTANCE_ID:-default}"
