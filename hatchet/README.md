# styrir on Hatchet

The personal SDLC (`workflow/sdlc.md`) as Hatchet workflows. One TypeScript worker; leaf tasks
shell out to `skald` / `heimr` / `gardr` / `git` on this machine, durable tasks only sequence them.
Replaces `styrir serve` and the Paperclip bridge.

```
sdlc-poll-skald  (cron */5)  skald list → spawn sdlc-ticket per unpaused building/reviewing ticket
sdlc-ticket <id>             durable; idempotent per ticket id
  skald-read
  build-phase ─ heimr-prepare-build → sandbox-run → git-reconcile → skald set reviewing
  │             (incomplete run ⇒ "continue" dispatch into the same workspace, ≤ maxBuildContinuations)
  review-phase ─ heimr-prepare-review (new workspace, diff+AC+checklist only) → sandbox-run
  │             verdict = severities: any blocking/should-fix ⇒ request-changes ⇒ next build round
  │             (≤ maxReviewRounds, then --paused)
  approve ⇒ skald --paused "waiting on Ian" ⇒ waitForEvent ticket:signal
  merged ⇒ done · rework <note> ⇒ one more build+review round · cancel ⇒ cancelled
sandbox-run                  gardr start → observe every pollIntervalSeconds → cleanup → HANDOFF.json
                             tenant-scoped concurrency "gardr-sandboxes" = maxConcurrentSandboxes
```

Not here: intake/`refining` (do it in a session; the workflow starts at `building`), parent/slice
aggregation (each slice is its own `sdlc-ticket`), PR thread replies, publishing/merging.

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

`heimr-prepare-build` writes `WORK.md` from the skald ticket (title, AC, repo `verify` command) and
asks for: branch `<ticket-id>` pushed to `origin`, a draft PR via `gh`, and a `HANDOFF.json` of shape
`{status: complete|partial|escalated, branch, commit, pr, summary, acceptance_criteria[{criterion,status,evidence}], blockers[], escalation}`. A worker that hits a blocker outside its scope sets `escalated`; the ticket goes back to `refining`, paused for human review.
`git-reconcile` checks the worktree independently; the handoff's word is never enough.

`heimr-prepare-review` prepares the review worktree from the build workspace's `repository/`
(which sits at the branch tip) and seals `target.diff` = `git diff <trunk>...HEAD`. The review
handoff shape is `{status, verdict, summary, acceptance_criteria[], findings[{severity,description,path,line}]}`.

## Redeploying

Edit, `npm run typecheck`, restart the worker. In-flight durable runs replay from their last
checkpoint against the new code, so keep the child-call order stable in `sdlc-ticket`,
`build-phase`, `review-phase` and `sandbox-run` while anything is running.
