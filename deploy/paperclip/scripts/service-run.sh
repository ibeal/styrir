#!/bin/sh
# Entry point for the Paperclip service, run either by hand or by a
# supervisor. Historically installed by patching the generated launchd
# plist (removed — see git history); now execed directly by the
# home-manager launchd agent (../../flake.nix / ../../nix/home-manager-module.nix)
# with no plist rewriting involved.
#
# It exists because a launchd agent inherits almost nothing: not the login
# shell's PATH, and not paperclip.env. Without this wrapper the service starts
# with upstream defaults for every env-only setting — most importantly
# PAPERCLIP_SETTING_DEFAULTS and PAPERCLIP_HIDDEN_SETTINGS, which are the
# feedback-trace-sharing floor and have no config.json equivalent. The
# instance would come up looking healthy with that floor silently absent.
#
# Env file location: defaults to paperclip.env next to this script (a
# checkout), but honors PAPERCLIP_ENV_FILE if set. The home-manager module
# sets it explicitly (its `environmentFile` option) because the flake-packaged
# copy of this script runs from the Nix store, not from a checkout — this is
# the same file either way, so the hand-run path and the service path cannot
# drift from each other.

set -eu

script_dir="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
default_deploy_dir="$(CDPATH='' cd -- "$script_dir/.." && pwd)"
env_file="${PAPERCLIP_ENV_FILE:-$default_deploy_dir/paperclip.env}"

if [ ! -f "$env_file" ]; then
  echo "error: $env_file is missing. Set PAPERCLIP_ENV_FILE, or run this from a checkout with paperclip.env in place (see README.md)." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
. "$env_file"
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
