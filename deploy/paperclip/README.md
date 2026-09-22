# Paperclip: self-hosted, locked down

This directory is the whole deployment: an empty, correctly configured
Paperclip instance for Ian's work laptop. It has no company provisioning, no
stage mapping, no bridge, and no exporter — those are later slices.

## Shape of the deployment, and why

- **PostgreSQL runs in Docker** (`docker-compose.postgres.yml`), as a
  standalone server Ian can `psql` into directly.
- **Paperclip itself runs on the host**, via the managed install
  (`paperclipai`), not in Docker.

  The reason is `PAPERCLIP_BIND=tailnet`: upstream detects the host's real
  Tailscale interface and binds to it. A container does not have the host's
  Tailscale interface unless you go out of your way to give it one (a
  sidecar, host networking, or a published port). Docker Desktop for Mac in
  particular does not support Linux-style host networking, so a
  containerized Paperclip cannot reliably reproduce "bind: tailnet" as
  upstream describes it. Running Paperclip as a normal host process — where
  `tailscale ip -4` and `PAPERCLIP_BIND=tailnet` mean what upstream says
  they mean — is the option that does not require patching or faking that
  detection. Only PostgreSQL, which nothing outside this machine needs to
  reach, goes in a container, and its published port is bound to
  `127.0.0.1` explicitly so Docker Desktop's default of publishing to all
  host interfaces doesn't put the database on the tailnet.
- **No custom Rust binary, no justfile.** A person reading this in a year
  needs `sh`, `docker compose`, and the `paperclipai` CLI that Paperclip
  itself requires — nothing else. The posture checker is a plain Node
  script (`posture/`) because Paperclip already requires Node 24.11+ on the
  host; that is not a new toolchain.

## What the laptop must supply (nothing here is a credential)

A fresh clone of this repository contains no credential. Before first
bring-up, on the laptop:

1. `cp postgres.env.example postgres.env` and fill in a real
   `POSTGRES_PASSWORD`.
2. `cp paperclip.env.example paperclip.env` and fill in:
   - `DATABASE_URL` (must match `postgres.env`'s credentials and
     `POSTGRES_HOST_PORT`),
   - `BETTER_AUTH_SECRET` and `PAPERCLIP_TOOL_ACTION_SIGNING_SECRET`, each
     generated with `openssl rand -hex 32`,
   - optionally `PAPERCLIP_ALLOWED_HOSTNAMES` if the phone/other devices use
     a custom Tailscale hostname.
3. Both `postgres.env` and `paperclip.env` are git-ignored (see
   `../../.gitignore`) — they never get committed.
4. The secrets master key is **not** supplied by either env file. It is
   auto-created by `paperclipai onboard` at its default path
   (`~/.paperclip/instances/default/secrets/master.key`), stays on the
   laptop, and is the operator's to back up (see "Secrets master key"
   below).

## Bring-up, step by step

Run on the work laptop (macOS, Docker Desktop installed and running):

```sh
cd deploy/paperclip
cp postgres.env.example postgres.env      # then edit
cp paperclip.env.example paperclip.env    # then edit

# Install the pinned version of Paperclip (see "Pinning and upgrading").
npx --registry https://registry.npmjs.org paperclipai install --version <PINNED_VERSION>

# Bring up standalone PostgreSQL and the Paperclip host service.
scripts/up.sh
```

`paperclipai onboard` runs interactively the first time `scripts/up.sh`
starts the service if the instance has never been configured; choose
`authenticated` → `private` when asked, matching `paperclip.env`. Onboarding
also creates the secrets master key and prints the board-claim URL. Open
that URL, sign in, and claim the instance to become its admin — see upstream
`upstream-docker-full.md` → "Authenticated Compose (Single Public URL)" for
the browser-claim flow, and `upstream-deployment-modes.md` → "Board Claim
Flow" for what claiming does.

If a custom Tailscale hostname is used instead of the bare `tailscale ip
-4` address:

```sh
npx paperclipai allowed-hostname <hostname>
```

### Comes back after a laptop restart

Two independent things must both survive a restart:

- **PostgreSQL**: Docker Desktop must be set to start at login (Docker
  Desktop → Settings → General → "Start Docker Desktop when you log in").
  `docker-compose.postgres.yml`'s `restart: unless-stopped` then brings the
  container back once the daemon is up.
- **Paperclip**: a launchd agent declared in **home-manager** (dotfiles),
  not `paperclipai service install`. The generated plist carries neither a
  usable PATH nor this deployment's environment, so under it `tailscale` is
  unfindable (bind=tailnet refuses to start) and, worse, the env-only
  feedback-sharing floor is silently absent. The home-manager agent invokes
  `scripts/service-run.sh` from this directory, which sources
  `paperclip.env`, resolves the tailnet address, and execs the server.
  A LaunchAgent runs in a user session, so it starts once Ian logs into the
  laptop, not at raw boot before login.

Run `scripts/up.sh` once after that initial setup; afterwards a machine
restart alone is enough, as long as Docker Desktop's login item and the
home-manager agent are both in place.

## Tailnet access, and nowhere else

- `PAPERCLIP_DEPLOYMENT_MODE=authenticated` + `PAPERCLIP_DEPLOYMENT_EXPOSURE=private`
  + `PAPERCLIP_BIND=tailnet` together mean: login required (Better Auth), no
  anonymous or `local_trusted` bypass, and the server binds to the detected
  Tailscale interface (see `upstream-tailscale-private-access.md`).
- From the phone or another of Ian's devices on the tailnet:
  `http://<tailscale-host-or-ip>:3100`.
- `docker-compose.postgres.yml` publishes PostgreSQL on `127.0.0.1` only —
  it is reachable from the laptop itself (`psql`), never from the tailnet or
  LAN.
- **Open question, not resolved here**: `research-notes.md` suggests
  `PAPERCLIP_AUTH_RATE_LIMIT_ENABLED=true` to counter Better Auth's rate
  limiting being off by default in private mode. None of the upstream
  `upstream-*.md` files given to this task document that variable, and the
  dispatch says not to invent an option that doesn't appear there. It is
  **not set** in `paperclip.env.example`. Flagging this back to Ian/host
  research rather than guessing at an unverified flag name — see
  `HANDOFF.json`.

## Every egress channel off

- **Product telemetry**: `PAPERCLIP_TELEMETRY_DISABLED=1` (env belt) is set
  in `paperclip.env.example`. Belt-and-braces per the research notes: also
  confirm the config-file brace by hand once the instance has been onboarded
  once —

  ```sh
  grep -A1 '"telemetry"' ~/.paperclip/instances/default/config.json
  # expect: "enabled": false
  ```

  If it reads `true`, run `paperclipai configure --section telemetry` (or
  edit the field) and set it to `false`. The posture checker also reads this
  file when given `--instance-config`.
- **Sentry / OpenTelemetry**: opt-in upstream; `SENTRY_DSN`,
  `SENTRY_DSN_FRONTEND`, `SENTRY_DSN_BACKEND`, `OTEL_EXPORTER_OTLP_ENDPOINT`
  are left unset. `paperclip.env.example` lists them commented out so nobody
  sets one later without noticing what it does.
- **Feedback-trace sharing** (the dangerous one — its bundle contains
  ticket/comment text): defaulted denied *and* floored so the UI control
  cannot re-enable it —

  ```
  PAPERCLIP_SETTING_DEFAULTS={"feedbackDataSharingPreference":"denied"}
  PAPERCLIP_HIDDEN_SETTINGS=instance.general.feedbackDataSharingPreference
  ```

  Both lines are required: a default alone is a user-overridable starting
  point, not a floor. `PAPERCLIP_HIDDEN_SETTINGS` for this key both hides
  the control in the UI and rejects value-changing writes with
  `403 settings_operator_managed` at the API. **Caveat**: the upstream docs
  supplied to this task give `"allowed"` as the only example value for
  `feedbackDataSharingPreference`; they do not enumerate the full set of
  valid values. `"denied"` is the natural opposite and is used here, but it
  is unverified against a live instance. `PAPERCLIP_SETTING_DEFAULTS`
  refuses startup on an invalid value, so a wrong guess here fails loudly
  (does not start) rather than silently defaulting to allowed — see
  `HANDOFF.json` and run the host verification procedure below.
- **No model-provider credentials**: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  `GEMINI_API_KEY`, `GOOGLE_API_KEY` must never appear in `paperclip.env` or
  the LaunchAgent's environment. All model execution for this deployment
  happens later, in Gardr sandboxes driven by slice 3 — never via Paperclip's
  own local-CLI adapters or managed sandbox targets.
- **Image choice consequence**: because Paperclip runs on the host (not the
  upstream Docker image), the agent CLIs the upstream image pre-installs
  (`claude`, `codex`, `opencode`, `gemini`) are simply not present on this
  machine's Paperclip process at all — one less thing to have to prove is
  unused.

## Secrets master key

`PAPERCLIP_SECRETS_MASTER_KEY_FILE` is deliberately left unset. The key
stays at its default path under `~/.paperclip/instances/default/secrets/`,
created with `0600` permissions by `paperclipai onboard`. Decision and
reasoning:

- The key is host-local state, not deployment configuration — it has no
  business being copyable via this repository, and an env var would
  encourage exactly that.
- A database backup without this key cannot decrypt local secrets (this
  instance has none configured yet, since this slice ships empty, but later
  slices will). Back up the key file together with database backups when
  slice 4 builds that; until then, treat
  `~/.paperclip/instances/default/secrets/master.key` as something Time
  Machine (or another laptop backup) must cover.
- Run `paperclipai doctor` periodically; it warns if the key file is
  readable by group/other.

## Egress-blocked smoke test (host verification)

With host egress to model providers and vendor endpoints blocked (e.g. a
firewall rule dropping outbound traffic to `api.anthropic.com`,
`api.openai.com`, `*.sentry.io`, and Paperclip's own telemetry collector),
the instance must still start, serve the UI, and accept ticket writes,
because none of those channels are needed for an empty, unconfigured
instance. Procedure:

```sh
# 1. Block egress to vendor/telemetry endpoints at the host firewall
#    (exact mechanism is the operator's choice: pf, Little Snitch, etc.)
# 2. Bring the instance up / restart it.
scripts/up.sh
# 3. From a tailnet-connected device:
curl http://<tailscale-host-or-ip>:3100/api/health
# expect: {"status":"ok"}
# 4. Sign in over the tailnet, open the board, create a ticket, add a
#    comment. Expect normal success with no errors in
#    `paperclipai service logs -f`.
```

## The posture check

`posture/posture-check.mjs` is the "is anything leaking?" answer. It:

- reads the running Paperclip process's effective environment (deployment
  mode/exposure/bind, telemetry, hidden settings, setting defaults,
  provider-credential absence),
- optionally reads the instance's `config.json` for the telemetry
  config-file brace,
- inspects actual listening sockets (via `lsof`/`ss`) to prove the real
  network exposure, not just intent,
- calls `GET /api/health`,
- optionally, given a logged-in session cookie, calls
  `GET /api/instance/settings/general` and attempts a value-changing
  `PATCH` to verify the feedback-sharing floor live, not just via env.

Everything above that is a pure function of already-gathered data
(`posture/checks.mjs`, `posture/parsing.mjs`) has unit tests
(`*.test.mjs`, run with `node --test`) and needs no live instance. Only the
network/HTTP/process-inspection glue in `posture-check.mjs` itself is
untestable without a live instance — that is expected, per this task's
constraints, and is exactly the boundary the tests are drawn at.

Run it on the laptop against the live instance:

```sh
# From this directory:
node posture/posture-check.mjs \
  --tailscale-address "$(tailscale ip -4)" \
  --instance-config ~/.paperclip/instances/default/config.json

# For the live (not just env-belt) feedback-sharing verification, also add:
#   --session-cookie "<paste the Cookie header from a signed-in browser tab>"
```

It exits non-zero and prints `RESULT: FAIL` if any non-skipped check fails.
Skipped checks (e.g. the live feedback-sharing check without a session
cookie, or the config-file check without `--instance-config`) are printed
loudly as `SKIP`, not silently treated as passing — the summary line always
states how many were skipped.

Run the unit tests:

```sh
node --test posture/*.test.mjs
```

## The flake

This repository's top-level `flake.nix` is the delivery mechanism for
everything below this line, for a consumer who has no checkout of this
repository — Ian's dotfiles flake on the work laptop, above all:

- `packages.<system>.paperclip-cli` — `scripts/pc.sh`, unchanged in
  behavior, packaged so it runs without a checkout.
- `packages.<system>.paperclip-service-run` — `scripts/service-run.sh`,
  likewise. This is what the home-manager module below execs; it is not a
  separate reimplementation of it.
- `packages.<system>.paperclip-posture-check` — `posture/posture-check.mjs`
  plus a `node` wrapper, satisfying "verifying the instance does not depend
  on knowing where in the repository the checker lives."
- `homeModules.paperclip` (also `.default`) — the module that
  supervises Paperclip as a macOS launchd agent. See
  `../../nix/home-manager-module.nix` for its options and their
  descriptions; `environmentFile` (pointing at this machine's
  `paperclip.env`) is the one every consumer must set, and has no default —
  enabling the module without it fails evaluation rather than starting
  Paperclip with the lockdown partially applied.

`scripts/pc.sh` and `scripts/service-run.sh` both honor a
`PAPERCLIP_ENV_FILE` override (falling back to `paperclip.env` next to the
script, i.e. this directory, when unset). That override is what lets the
same two scripts run identically from a checkout (`scripts/up.sh`'s
foreground fallback) and from the Nix store (the home-manager agent, which
sets `PAPERCLIP_ENV_FILE` to its `environmentFile` option) — one code path,
two callers, per the acceptance criteria. Nothing else about either script
changed.

Standalone PostgreSQL (`docker-compose.postgres.yml`) is **not** a flake
output: it is still brought up from a checkout via `scripts/up.sh`, which
also remains this repository's own front door for the Paperclip service —
see its `README.md` note about restarting via `launchctl kickstart` once the
home-manager agent exists, or falling back to `scripts/service-run.sh` in
the foreground if it does not.

The dotfiles side (pinning this flake as an input, enabling
`homeModules.paperclip`, setting its options) is a separate ticket
and is not written here. What is guaranteed from this side: a consumer needs
only the flake reference, `environmentFile`, and (optionally) `instanceId`,
`port`, `extraPath`, `logDirectory` — no copied scripts, no path into this
repository, and no duplicated lockdown environment, because the module
points at the same `paperclip.env` the hand-run scripts already read rather
than re-declaring any of its settings in Nix.

### Host verification (needs nix; not runnable in this sandbox)

```sh
# From the repository root, on the laptop:
nix flake lock                     # first time only, needs network access
nix flake check                    # expect: no errors; runs the posture unit tests too
nix build .#paperclip-cli .#paperclip-service-run .#paperclip-posture-check
./result/bin/paperclip-posture-check --help   # or any of the three built binaries
nix eval .#homeModules.paperclip.options.services.paperclip.enable.description
```

Expect `nix flake check` to pass and each `nix build` to produce a `result`
symlink with the named binary inside. There is no way to verify
`launchd.agents` wiring itself without a real home-manager configuration
enabling the module (the dotfiles ticket) and a `home-manager switch` —
after that, verify with:

```sh
launchctl print gui/$(id -u)/org.styrir.paperclip   # expect: state = running
tail -f ~/Library/Logs/paperclip/paperclip.out.log  # or wherever logDirectory points
curl http://$(tailscale ip -4):3100/api/health       # expect: {"status":"ok"}
```

and confirm removal is clean by disabling the module, `home-manager switch`
again, then:

```sh
launchctl print gui/$(id -u)/org.styrir.paperclip   # expect: no such process / not found
```

## Pinning and upgrading

`VERSION` records the exact upstream release this deployment is pinned to.
The sandbox this deployment layer was authored in has no network access to
resolve or verify a real release, so `VERSION` ships as an explicit
placeholder — see that file for the exact commands to run on first bring-up
to resolve and commit a real pin.

To move to a newer release:

```sh
npx --registry https://registry.npmjs.org paperclipai install --version <NEW_VERSION>
paperclipai update --version <NEW_VERSION>   # takes a backup first
```

then update `VERSION` and commit it. `paperclipai update --rollback` reverts
to the previously retained payload if the new version misbehaves.

## Acceptance criteria mapping

See `HANDOFF.json` for the per-criterion status (done / partial /
deferred-to-host-verification / not started) and the exact evidence or
procedure for each.
