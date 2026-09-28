import type { JsonObject } from '@hatchet-dev/typescript-sdk';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hatchet } from '../client.js';
import { logged, run } from '../exec.js';
import { repoConfig, type RepoConfig } from '../config.js';
import type { Ticket } from './skald.js';

export type Finding = {
  severity: 'blocking' | 'should-fix' | 'nit' | 'note' | string;
  description: string;
  path?: string;
  line?: number;
};

// `heimr repo prepare` strips the clone origin, so the worktree has no trunk ref of its own.
// Fetch it into refs/remotes/origin/<trunk> and hand back that ref.
async function fetchTrunk(cwd: string, trunk: string): Promise<string> {
  await run('git', ['fetch', 'origin', `${trunk}:refs/remotes/origin/${trunk}`], { cwd });
  return `origin/${trunk}`;
}

export async function resolveWorkspacePath(workspace: string): Promise<string> {
  const { stdout } = await run('heimr', ['path', workspace]);
  return stdout.trim();
}

// The build dispatch that names a round: `build` is round 1, `rework-N` is round N (N > 1).
// `*-continue-*` dispatches never name a round on their own — they are attempts within one.
export function primaryDispatchName(round: number): string {
  return round === 1 ? 'build' : `rework-${round}`;
}

export function parsePrimaryRound(dispatchName: string): number | null {
  if (dispatchName === 'build') return 1;
  const m = /^rework-(\d+)$/.exec(dispatchName);
  return m ? Number(m[1]) : null;
}

function listDispatches(workspacePath: string): string[] {
  try {
    return readdirSync(`${workspacePath}/dispatches`);
  } catch {
    return [];
  }
}

function pendingReworkPath(workspacePath: string): string {
  return `${workspacePath}/PENDING_REWORK.json`;
}

// Written directly to the workspace root, outside heimr's dispatch machinery: it is a durable
// note *about* the next dispatch, not a dispatch input, and heimr has no "arbitrary workspace
// file" command. `heimr check` only verifies sealed dispatch inventories, so this is inert to it.
export function writePendingRework(workspacePath: string, note: string): void {
  writeFileSync(pendingReworkPath(workspacePath), JSON.stringify({ note, at: new Date().toISOString() }, null, 2));
}

// `rata only profile container` is the standing sandboxed-worker protocol. The header
// and any host path are stripped because the file is a dispatch input, not a Rata artifact.
async function containerContext(): Promise<string> {
  const { stdout } = await run('rata', ['only', 'profile', 'container']);
  return stdout
    .split('\n')
    .filter((line) => !line.startsWith('# Ratatoskr Context Pack') && !line.includes('/Users/'))
    .join('\n');
}

async function sealDispatch(
  workspace: string,
  dispatch: string,
  inputs: Record<string, string>,
): Promise<void> {
  await run('heimr', ['dispatch', 'new', workspace, dispatch]);
  for (const [path, content] of Object.entries(inputs)) {
    await run('heimr', ['dispatch', 'put', workspace, dispatch, '--path', path], { stdin: content });
  }
  await run('heimr', ['dispatch', 'seal', workspace, dispatch]);
}

function prCommand(repo: RepoConfig): string {
  return repo.forge === 'azure-devops'
    ? '`az repos pr create --draft --target-branch ' + repo.trunk + '`'
    : '`gh pr create --draft --base ' + repo.trunk + '`';
}

function buildWorkMd(ticket: Ticket, repo: RepoConfig): string {
  const verify = repo.verify;
  return `# ${ticket.title}

## Goal
Implement skald ticket ${ticket.id} in this repository so that every acceptance criterion below holds.${ticket.link ? `\nTracker: ${ticket.link}` : ''}

## Acceptance criteria
${ticket.acceptanceCriteria}

## Constraints
- Change only this repository. A missing fact is a blocker to report in HANDOFF.json, not something to guess.
- Commit on branch \`${ticket.id}\`; push it to \`origin\`.
- No plans, notes, or summaries in the repository: the diff is the deliverable.
- Commit subjects: \`type(scope): description\`, body wrapped at 72 columns, referencing ${ticket.id}.

## Verification
\`\`\`sh
${verify}
\`\`\`
All of it must pass before the handoff is marked complete.

## Deliverable
- Branch \`${ticket.id}\` pushed to origin.
- A draft PR opened with ${prCommand(repo)} (body ≤ 10 lines: one sentence, ≤ 4 bullets, one "Verified:" line).
- HANDOFF.json kept current, shape:
  \`{"version":1,"status":"complete"|"partial"|"escalated","branch":"…","commit":"…","pr":"<url>|null","summary":"…","acceptance_criteria":[{"criterion":"…","status":"done"|"partial"|"not-started","evidence":"…"}],"blockers":["…"],"escalation":"…"|null}\`

## Escalation
Try to resolve blockers yourself first. If a blocker cannot be resolved within this task's scope —
the acceptance criteria assume something untrue, a decision belongs to a human, a tool or network
policy makes a criterion impossible here — stop, commit and push what is sound, and set
\`"status":"escalated"\` with \`"escalation"\` stating the problem and the decision or change needed.
The ticket goes back to refining for a human; do not keep retrying or narrow the criteria yourself.
`;
}

function reviewWorkMd(ticket: Ticket, branch: string): string {
  return `# ${ticket.title} (review)

## Frame
Branch \`${branch}\` implements skald ticket ${ticket.id}. The diff against trunk is in the dispatch as \`target.diff\`; the worktree is checked out at the branch tip. Review the diff against the acceptance criteria and checklist only.

## Acceptance criteria
${ticket.acceptanceCriteria}

## Review checklist
- Design / readability / correctness: fits the existing architecture, idiomatic, no correctness bugs.
- Production safety: failure modes, partial failure, concurrency, bad data, observability, rollback.
- AC fit: map each criterion to covered / partial / missing; flag scope drift.
- Severity: blocking / should-fix / nit, each tied to \`path:line\`. Documentation findings are nits unless grossly misleading. A nit is genuinely optional.
- Verdict follows severity mechanically: approve only when there is nothing above nit.

## Read-only boundary
Do not modify the repository or worktree, push, comment on the PR, or touch any ticket state. Findings only.

## Expected HANDOFF.json shape
\`{"version":1,"status":"complete","verdict":"approve"|"request-changes","summary":"…","acceptance_criteria":[{"criterion":"…","status":"done"|"partial"|"missing","evidence":"…"}],"findings":[{"severity":"blocking"|"should-fix"|"nit","description":"…","path":"…","line":0}]}\`
`;
}

function findingsMarkdown(findings: Finding[]): string {
  const lines = findings.map((f) =>
    `- **${f.severity}**${f.path ? ` \`${f.path}${f.line ? `:${f.line}` : ''}\`` : ''} — ${f.description}`,
  );
  return `# Review findings to address\n\nFix every blocking and should-fix finding. Nits are optional; say in HANDOFF.json which you took and which you left. Then re-run verification, commit, push, and update the PR.\n\n${lines.join('\n')}\n`;
}

// One build workspace per ticket for the whole `building` lifetime: a review round that
// sends work back seals a *new* dispatch into it so the worker resumes its own state.
export const heimrPrepareBuild = hatchet.task({
  name: 'heimr-prepare-build',
  retries: 1,
  fn: logged(async (input: {
    ticket: Ticket;
    dispatch: string;
    findings?: Finding[];
    continuation?: string;
  }): Promise<{ workspace: string; workspacePath: string; dispatch: string }> => {
    const repo = repoConfig(input.ticket.repo);
    const workspace = `${input.ticket.id}-build`;
    // `heimr path` answers for a workspace that does not exist yet, so probe the directory.
    const path = await resolveWorkspacePath(workspace);
    if (!existsSync(`${path}/WORK.md`)) {
      await run('heimr', ['new', workspace]);
      await run('heimr', ['work', 'set', workspace, '--from', '/dev/stdin'], {
        stdin: buildWorkMd(input.ticket, repo),
      });
      await run('heimr', ['repo', 'prepare', workspace, '--from', repo.checkout]);
      await run('heimr', ['repo', 'set-push-remote', workspace, '--url', repo.pushUrl]);
    }

    // Re-entrant: a replayed or respawned run finds its dispatch already sealed and moves on.
    if (!existsSync(`${path}/dispatches/${input.dispatch}/dispatch.json`)) {
      const inputs: Record<string, string> = { 'container-context.md': await containerContext() };
      if (input.findings?.length) inputs['review-findings.md'] = findingsMarkdown(input.findings);
      if (input.continuation) inputs['continue.md'] = input.continuation;
      await sealDispatch(workspace, input.dispatch, inputs);
    }

    await run('heimr', ['check', workspace]);
    return { workspace, workspacePath: path, dispatch: input.dispatch };
  }),
});

// Fresh eyes: always a new workspace, prepared from the build worktree (which sits at the
// branch tip), with only the AC, the diff, and the checklist. Never a build dispatch file.
export const heimrPrepareReview = hatchet.task({
  name: 'heimr-prepare-review',
  retries: 1,
  fn: logged(async (input: {
    ticket: Ticket;
    round: number;
    buildWorkspacePath: string;
  }): Promise<{ workspace: string; workspacePath: string; dispatch: string; branch: string }> => {
    const repo = repoConfig(input.ticket.repo);
    const buildRepo = `${input.buildWorkspacePath}/repository`;
    if (!existsSync(buildRepo)) throw new Error(`no repository at ${buildRepo}`);

    const { stdout: branchOut } = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: buildRepo });
    const branch = branchOut.trim();
    const trunkRef = await fetchTrunk(buildRepo, repo.trunk);
    const { stdout: diff } = await run('git', ['diff', `${trunkRef}...HEAD`], { cwd: buildRepo });
    if (!diff.trim()) throw new Error(`empty diff between ${repo.trunk} and ${branch} in ${buildRepo}`);

    const workspace = `${input.ticket.id}-review-${input.round}`;
    const path = await resolveWorkspacePath(workspace);
    if (!existsSync(`${path}/dispatches/review/dispatch.json`)) {
      await run('heimr', ['new', workspace]);
      await run('heimr', ['work', 'set', workspace, '--from', '/dev/stdin'], {
        stdin: reviewWorkMd(input.ticket, branch),
      });
      await run('heimr', ['repo', 'prepare', workspace, '--from', buildRepo]);
      await sealDispatch(workspace, 'review', {
        'container-context.md': await containerContext(),
        'target.diff': diff,
      });
    }
    await run('heimr', ['check', workspace]);
    return { workspace, workspacePath: path, dispatch: 'review', branch };
  }),
});

// What a build round's active dispatch is *right now*: the primary (`build`/`rework-N`) if no
// continuation of it exists yet, otherwise the highest-numbered `*-continue-N` of that primary.
// Derived from disk every call, so a brand-new process (a respawn, not a replay) resumes the
// same attempt count a prior process left off at instead of re-using attempt 0 and risking a
// dispatch name collision with a continuation the prior process already sealed.
export const heimrActiveDispatch = hatchet.task({
  name: 'heimr-active-dispatch',
  fn: logged(async (input: { workspacePath: string; primary: string }): Promise<{ dispatch: string; attempt: number }> => {
    const prefix = `${input.primary}-continue-`;
    const attempts = listDispatches(input.workspacePath)
      .filter((n) => n.startsWith(prefix))
      .map((n) => Number(n.slice(prefix.length)))
      .filter((n) => Number.isInteger(n) && n > 0);
    const attempt = attempts.length ? Math.max(...attempts) : 0;
    return { dispatch: attempt > 0 ? `${prefix}${attempt}` : input.primary, attempt };
  }),
});

// The durable record of every round a ticket's build workspace has ever seen, read straight off
// disk so it survives every process this ticket has ever been driven by, not just this one.
export const heimrBuildRounds = hatchet.task({
  name: 'heimr-build-rounds',
  fn: logged(async (input: { ticketId: string }): Promise<{ workspace: string; workspacePath: string | null; rounds: number[] }> => {
    const workspace = `${input.ticketId}-build`;
    const path = await resolveWorkspacePath(workspace);
    if (!existsSync(`${path}/WORK.md`)) return { workspace, workspacePath: null, rounds: [] };
    const rounds = listDispatches(path)
      .map(parsePrimaryRound)
      .filter((r): r is number => r !== null)
      .sort((a, b) => a - b);
    return { workspace, workspacePath: path, rounds };
  }),
});

// The durable findings for a rework round: the actionable findings from the review round that
// just judged the completed build (if one ran), plus any human note left by `styrir signal
// rework`. Never trust an in-memory value for this — it must be reconstructable by a process
// that has no memory of the round that just finished, which is the whole point of a respawn fix.
export const heimrResolveRework = hatchet.task({
  name: 'heimr-resolve-rework',
  fn: logged(async (input: { ticketId: string; buildWorkspacePath: string; completedRound: number }): Promise<{ findings: Finding[] }> => {
    const findings: Finding[] = [];
    try {
      const { stdout } = await run('heimr', ['dispatch', 'handoff', `${input.ticketId}-review-${input.completedRound}`, 'review']);
      const handoff = JSON.parse(stdout) as ReviewHandoff;
      for (const f of handoff.findings ?? []) {
        if (f.severity === 'blocking' || f.severity === 'should-fix') findings.push(f);
      }
    } catch {
      // No completed review round on record — e.g. rework was requested before any review ran.
    }

    const noteFile = pendingReworkPath(input.buildWorkspacePath);
    if (existsSync(noteFile)) {
      const data = JSON.parse(readFileSync(noteFile, 'utf8')) as { note?: string };
      if (data.note) findings.push({ severity: 'should-fix', description: `Ian: ${data.note}` });
      rmSync(noteFile); // consume once: it must not also feed a later round
    }
    return { findings };
  }),
});

export type BuildHandoff = {
  version: number;
  status: 'complete' | 'partial' | 'escalated' | string;
  escalation?: string | null;
  branch?: string | null;
  commit?: string | null;
  pr?: string | null;
  summary?: string;
  acceptance_criteria?: { criterion: string; status: string; evidence?: string }[];
  blockers?: string[];
};

export type ReviewHandoff = {
  version: number;
  status: string;
  verdict: 'approve' | 'request-changes' | string;
  summary?: string;
  acceptance_criteria?: { criterion: string; status: string; evidence?: string }[];
  findings?: Finding[];
};

export type GitState = { branch: string; dirty: boolean; ahead: number; pushed: boolean; onTrunk: boolean };

// Whether a build round's active dispatch is actually done, independent of what the handoff or
// the caller assumed: no handoff, an incomplete/blocked handoff, or a worktree that isn't a
// pushed, clean branch off trunk are all reasons this round is not over.
export function buildProblems(handoff: BuildHandoff | null, git: GitState, trunk: string): string[] {
  const out: string[] = [];
  if (!handoff) out.push('no HANDOFF.json');
  else {
    if (handoff.status !== 'complete') out.push(`handoff status ${handoff.status}`);
    for (const ac of handoff.acceptance_criteria ?? []) {
      if (ac.status !== 'done') out.push(`AC ${ac.status}: ${ac.criterion}`);
    }
    for (const b of handoff.blockers ?? []) out.push(`blocker: ${b}`);
    if (!handoff.pr) out.push('no PR in handoff');
  }
  if (git.onTrunk) out.push(`still on ${trunk}`);
  if (git.ahead === 0) out.push('no commits ahead of trunk');
  if (git.dirty) out.push('worktree dirty');
  if (!git.pushed) out.push('branch not pushed');
  return out;
}

export const heimrHandoff = hatchet.task({
  name: 'heimr-handoff',
  retries: 1,
  fn: logged(async (input: { workspace: string; dispatch: string }): Promise<{ handoff: JsonObject | null }> => {
    try {
      const { stdout } = await run('heimr', ['dispatch', 'handoff', input.workspace, input.dispatch]);
      return { handoff: JSON.parse(stdout) };
    } catch (err) {
      // A worker that died before writing a handoff is a reconcile case, not a crash.
      return { handoff: null };
    }
  }),
});

// What the sandbox left behind, independently of what it claimed.
export const gitReconcile = hatchet.task({
  name: 'git-reconcile',
  fn: logged(async (input: { workspacePath: string; trunk: string }): Promise<GitState> => {
    const cwd = `${input.workspacePath}/repository`;
    const branch = (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })).stdout.trim();
    // Untracked files (lockfiles, tool caches) are not stranded work.
    const dirty = (await run('git', ['status', '--porcelain', '--untracked-files=no'], { cwd })).stdout.trim() !== '';
    const trunkRef = await fetchTrunk(cwd, input.trunk);
    const ahead = Number((await run('git', ['rev-list', '--count', `${trunkRef}..HEAD`], { cwd })).stdout.trim());
    let pushed = false;
    try {
      await run('git', ['fetch', 'origin', branch], { cwd });
      const local = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();
      const remote = (await run('git', ['rev-parse', `origin/${branch}`], { cwd })).stdout.trim();
      pushed = local === remote;
    } catch {
      pushed = false;
    }
    return { branch, dirty, ahead, pushed, onTrunk: branch === input.trunk };
  }),
});
