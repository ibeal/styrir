# styrir on Hatchet

The personal SDLC (`workflow/sdlc.md`) as Hatchet workflows. One TypeScript worker; leaf tasks
shell out to `skald` / `heimr` / `gardr` / `git` on this machine, durable tasks only sequence them.
Replaces `styrir serve` and the Paperclip bridge.

```
sdlc-poll-skald  (cron */5)  skald list → spawn sdlc-ticket per unpaused building/reviewing ticket
sdlc-ticket <id>             durable; idempotent per ticket id
  skald-read
  resolve-entry-state ─ heimr-build-rounds + heimr-active-dispatch + heimr-handoff + git-reconcile
  │   derives the round and mode from disk every run, never a local counter:
  │     no build workspace yet              ⇒ first-build, round 1
  │     active dispatch incomplete          ⇒ continue,    same round, resumed in place
  │     ticket already reviewing            ⇒ review-only, same round, build-phase skipped
  │     active dispatch complete + building ⇒ rework,      round + 1 (heimr-prepare-build sources its own inbox)
  build-phase ─ heimr-prepare-build → heimr-active-dispatch (attempt count from disk) → sandbox-run
  │             → git-reconcile → skald set reviewing
  │             (incomplete run ⇒ "continue" dispatch into the same workspace, ≤ maxBuildContinuations;
  │             the continuation number is derived from existing `*-continue-N` dispatches, so a
  │             respawned attempt can never reseal a name a prior process already used)
  review-phase ─ heimr-prepare-review (new workspace per round, diff+AC+checklist only)
  │             → heimr-handoff (skip the sandbox only if this round's dispatch already judged it)
  │             → sandbox-run
  │             verdict = severities: any blocking/should-fix ⇒ request-changes ⇒ next build round
  │             (≤ maxReviewRounds, then --paused)
  approve ⇒ skald --paused "waiting on Ian" ⇒ waitForEvent ticket:signal
  merged ⇒ done · rework ⇒ one more build+review round (next build dispatch already carries the
  prior review handoff + any staged note) · cancel ⇒ cancelled
sandbox-run                  gardr start → observe every pollIntervalSeconds → cleanup → HANDOFF.json
                             tenant-scoped concurrency "gardr-sandboxes" = maxConcurrentSandboxes
```

Not here: intake/`refining` (do it in a session; the workflow starts at `building`), parent/slice
aggregation (each slice is its own `sdlc-ticket`), PR thread replies, publishing/merging.

## Derived state, not run state

A Hatchet run can end (pause, escalation, worker restart) and be respawned by the next poll cycle as
a brand-new process with no memory of the one before it. Only skald's `status`/`paused` and the
heimr build workspace on disk survive that gap, so every run derives its round, its findings, and
whether to build at all from those two things at the top of `sdlc-ticket` — never from a local
variable seeded to `1`. The dispatch names carry the round (`build` = round 1, `rework-N` = round
N, `<primary>-continue-N` = an attempt within a round) precisely so a fresh process can read them
back off disk and recover where the last one left off, and never reseal a name a prior process
already used.

`styrir signal <id> rework "<note>"` stages the note as `inbox/human-note.md` in the *next* build
round's dispatch — created early via `heimr dispatch new`/`dispatch put` if it doesn't exist yet,
never a raw write into the workspace — then unparks the ticket, so it works whether or not a run is
currently alive to catch the `ticket:signal` event. That dispatch is exactly the one
`heimr-prepare-build` seals when the round actually starts, live or respawned, so it just adds its
usual inputs (`container-context.md`, and `inbox/review-<round>.handoff.json` — the prior review
round's HANDOFF.json verbatim) to what's already staged there and seals once.

A fresh run's resolved mode and reason go into the skald log as one line
(`hatchet: resumed — mode <mode> (round <n>): <reason>`), so a human reading the ticket's log
always sees which of first build / continue / rework / review-only was chosen and why.

## Run

```nu
cd hatchet
cp styrir.config.example.json styrir.config.json   # one entry per repo; specs must exist in gardr
npm install
npm run worker                                       # registers the workflows on connect
```

Connection comes from `~/.hatchet/profiles.yaml` (the `hatchet` CLI's default profile;
`HATCHET_PROFILE` picks another) unless `HATCHET_CLIENT_TOKEN` is set. The worker inherits
`SKALD_STORE`, `HEIMR_ROOT`, `GARDR_ROOT` and PATH from the shell that starts it, and must run on
the laptop that owns those stores — never in a container.

```nu
npm run start -- <ticket-id>                     # or wait for the cron
npm run signal -- <ticket-id> merged             # after you merge the PR
npm run signal -- <ticket-id> rework "note…"     # one more build+review round
npm run signal -- <ticket-id> cancel
hatchet tui                                      # watch runs
```

## Watching it

Everything below stays on this machine: the worker talks only to the local hatchet-lite, and the
`hatchet` CLI's own telemetry is off with `HATCHET_CLI_TELEMETRY_ENABLED=false`.

- **Workers** — the worker registers in the tenant that minted its token. The dashboard only lists
  tenants your user belongs to, so mint the token from the tenant you look at (Settings → API
  Tokens), `hatchet profile add --name <tenant> --token …`, and set it as `defaultprofile`.
- **Runs** — `sdlc-poll-skald` reports `{spawned, alreadyRunning}`; a ticket with a live
  `sdlc-ticket` run is *alreadyRunning*, not a failure.
- **Logs** (per task run) — every shell-out logs `$ cmd args`, then `✓`/`✗` with duration and a
  stderr tail.
- **Events** — `sdlc:ticket` events mark each phase boundary (`started`, `build`, `built`, `review`,
  `reviewed`, `awaiting-signal`, `signal`, `paused`, `escalated`, `done`, `cancelled`); filter by
  the `ticketId` metadata. A durable replay may repeat one — they are a timeline, not a trigger.

## Contracts the sandbox is held to

heimr owns the agent prompts and the handoff shapes — run `heimr docs` for both; this file doesn't
restate them. Styrir's part of the contract is narrower:

- `heimr-prepare-build`/`heimr-prepare-review` render `WORK.md` by substituting the `{{token}}`
  placeholders `heimr template build|review` declares (title, ticket id, AC, branch, trunk, verify
  command, PR command, PR url) literally; a token this repo doesn't supply is left as-is.
  `WORK.md` is re-rendered from the current ticket — re-read from skald, never the object read at
  run start — on every dispatch prepared (primary, rework, and every `*-continue-N`), not only
  when the workspace is first created; workspace creation, `repo prepare`, and
  `set-push-remote` still happen only then. It is only ever rewritten while preparing a
  dispatch, never during `sandbox-run`.
- A rework build dispatch's `inbox/` holds the judged review round's `HANDOFF.json` verbatim
  (`heimr dispatch handoff` → `heimr dispatch put`) plus, if `styrir signal rework` ran,
  `human-note.md`. A review dispatch never gets an inbox.
- `git-reconcile` checks the worktree independently of what a build handoff claims; a worker that
  hits a blocker outside its scope sets `escalated`, and the ticket goes back to `refining`, paused
  for human review.
- Verdict/rework routing reads a handoff's `status`/`verdict`/finding `severity` and disk state,
  exactly as before; a handoff's `threads`/`thread_url` fields (PR-thread bookkeeping the
  builder/reviewer own directly on the forge) are not read here.

## Model resolution

`sandbox-run` resolves a model before every gardr run and passes it explicitly with
`--model`; the spec's own pinned model is never used. Order:

```
tier     = ticket.complexity ?? repos.<slug>.defaultComplexity[status] ?? models.defaultComplexity[status]
provider = ticket.provider   ?? models.defaultProvider
model    = models.tiers[provider][tier]
```

`status` is `building` for a build-phase run, `reviewing` for a review-phase run. `tiers` is 4
model strings per provider, indexed 0 (cheapest/fastest) to 3 (strongest). A missing tier, an
unknown provider, or a status with no default (no ticket value, no repo override, no global
default) fails the run with a `NonRetryableError` naming the missing key — it never falls back to
whatever model the gardr spec pins. Each sandbox run logs the resolved `tier`/`provider`/`model`
to the ticket once, before starting gardr.

`styrir.config.json`'s top-level `models` block sets the defaults; a repo entry's own
`defaultComplexity` overrides the global one per status (see `styrir.config.example.json`).

## Redeploying

Edit, `npm run typecheck`, restart the worker. In-flight durable runs replay from their last
checkpoint against the new code, so keep the child-call order stable in `sdlc-ticket`,
`build-phase`, `review-phase` and `sandbox-run` while anything is running.
