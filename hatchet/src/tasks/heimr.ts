import type { JsonObject } from '@hatchet-dev/typescript-sdk';
import { existsSync, readdirSync } from 'node:fs';
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

function isSealed(workspacePath: string, dispatch: string): boolean {
  return existsSync(`${workspacePath}/dispatches/${dispatch}/dispatch.json`);
}

// Only sealed dispatches record a round or attempt. An unsealed directory is a note that
// `styrir signal rework` staged ahead of its dispatch, not evidence that the dispatch ran.
function listSealedDispatches(workspacePath: string): string[] {
  try {
    return readdirSync(`${workspacePath}/dispatches`).filter((name) => isSealed(workspacePath, name));
  } catch {
    return [];
  }
}

function highestSealedRound(workspacePath: string): number {
  const rounds = listSealedDispatches(workspacePath)
    .map(parsePrimaryRound)
    .filter((r): r is number => r !== null);
  return rounds.length ? Math.max(...rounds) : 0;
}

function latestAttempt(workspacePath: string, primary: string): number {
  const prefix = `${primary}-continue-`;
  const attempts = listSealedDispatches(workspacePath)
    .filter((n) => n.startsWith(prefix))
    .map((n) => Number(n.slice(prefix.length)))
    .filter((n) => Number.isInteger(n) && n > 0);
  return attempts.length ? Math.max(...attempts) : 0;
}

export function continuationDispatchName(primary: string, attempt: number): string {
  return `${primary}-continue-${attempt}`;
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

// The only way anything is ever written into a heimr workspace: create the dispatch directory
// through `heimr dispatch new` the first time (a dispatch may already exist and be unsealed —
// `styrir signal rework` stages `inbox/human-note.md` into a future round's dispatch ahead of
// that round's own prepare step, so "already exists" here is expected, not an error), then put
// the file. Refuses outright if the dispatch is already sealed: there is no way to add to it.
export async function stageDispatchFile(
  workspace: string,
  workspacePath: string,
  dispatch: string,
  path: string,
  content: string,
): Promise<void> {
  if (isSealed(workspacePath, dispatch)) {
    throw new Error(`dispatch ${dispatch} in workspace ${workspace} is already sealed; too late to add ${path}`);
  }
  if (!existsSync(`${workspacePath}/dispatches/${dispatch}`)) {
    await run('heimr', ['dispatch', 'new', workspace, dispatch]);
  }
  await run('heimr', ['dispatch', 'put', workspace, dispatch, '--path', path], { stdin: content });
}

async function sealDispatch(
  workspace: string,
  workspacePath: string,
  dispatch: string,
  inputs: Record<string, string>,
): Promise<void> {
  for (const [path, content] of Object.entries(inputs)) {
    await stageDispatchFile(workspace, workspacePath, dispatch, path, content);
  }
  await run('heimr', ['dispatch', 'seal', workspace, dispatch]);
}

function prCommand(repo: RepoConfig): string {
  return repo.forge === 'azure-devops'
    ? '`az repos pr create --draft --target-branch ' + repo.trunk + '`'
    : '`gh pr create --draft --base ' + repo.trunk + '`';
}

// heimr owns the agent prompt text; styrir only substitutes the tokens its WORK.md scaffold
// declares. A token this repo does not supply is left as `{{token}}` verbatim — no other
// templating, per the styrir/heimr inbox contract.
async function renderTemplate(kind: 'build' | 'review', tokens: Record<string, string>): Promise<string> {
  const { stdout } = await run('heimr', ['template', kind]);
  return stdout.replace(/\{\{(\w+)\}\}/g, (match, name: string) => (name in tokens ? tokens[name] : match));
}

function buildTokens(ticket: Ticket, repo: RepoConfig): Record<string, string> {
  return {
    title: ticket.title,
    ticket_id: ticket.id,
    tracker: ticket.link ?? '',
    acceptance_criteria: ticket.acceptanceCriteria,
    branch: ticket.id,
    trunk: repo.trunk,
    verify: repo.verify,
    pr_command: prCommand(repo),
    pr: ticket.pr ?? '',
  };
}

function reviewTokens(ticket: Ticket, repo: RepoConfig, branch: string): Record<string, string> {
  return {
    title: ticket.title,
    ticket_id: ticket.id,
    acceptance_criteria: ticket.acceptanceCriteria,
    branch,
    trunk: repo.trunk,
    pr: ticket.pr ?? '',
  };
}

// One build workspace per ticket for the whole `building` lifetime: a review round that
// sends work back seals a *new* dispatch into it so the worker resumes its own state.
export const heimrPrepareBuild = hatchet.task({
  name: 'heimr-prepare-build',
  retries: 1,
  fn: logged(async (input: {
    ticket: Ticket;
    dispatch: string;
    continuation?: string;
  }): Promise<{ workspace: string; workspacePath: string; dispatch: string }> => {
    const repo = repoConfig(input.ticket.repo);
    const workspace = `${input.ticket.id}-build`;
    // `heimr path` answers for a workspace that does not exist yet, so probe the directory.
    const path = await resolveWorkspacePath(workspace);
    const isNewWorkspace = !existsSync(`${path}/WORK.md`);
    if (isNewWorkspace) {
      await run('heimr', ['new', workspace]);
    }
    // Re-rendered from the caller's (freshly re-read) ticket on every prepare, not only when the
    // workspace is first created, so a later round's AC and `pr` are never stuck at round one's.
    await run('heimr', ['work', 'set', workspace, '--from', '/dev/stdin'], {
      stdin: await renderTemplate('build', buildTokens(input.ticket, repo)),
    });
    if (isNewWorkspace) {
      await run('heimr', ['repo', 'prepare', workspace, '--from', repo.checkout]);
      await run('heimr', ['repo', 'set-push-remote', workspace, '--url', repo.pushUrl]);
    }

    // Re-entrant: a replayed or respawned run finds its dispatch already sealed and moves on.
    if (!isSealed(path, input.dispatch)) {
      const inputs: Record<string, string> = { 'container-context.md': await containerContext() };
      if (input.continuation) inputs['continue.md'] = input.continuation;
      // A rework round's primary dispatch (never a continuation) carries the review round that
      // sent it back, verbatim, so the worker sees the judged findings themselves rather than a
      // styrir paraphrase of them. A human-requested rework can start a round no review sent
      // back; that round has no review handoff to carry.
      const primaryRound = parsePrimaryRound(input.dispatch);
      if (primaryRound !== null && primaryRound > 1) {
        const priorReviewRound = primaryRound - 1;
        const reviewWorkspace = `${input.ticket.id}-review-${priorReviewRound}`;
        if (isSealed(await resolveWorkspacePath(reviewWorkspace), 'review')) {
          const { stdout: handoff } = await run('heimr', ['dispatch', 'handoff', reviewWorkspace, 'review']);
          inputs[`inbox/review-${priorReviewRound}.handoff.json`] = handoff;
        }
      }
      await sealDispatch(workspace, path, input.dispatch, inputs);
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
    const isNewWorkspace = !existsSync(`${path}/WORK.md`);
    if (isNewWorkspace) {
      await run('heimr', ['new', workspace]);
    }
    // Re-rendered from the caller's (freshly re-read) ticket on every prepare, including a
    // respawn that finds this round's dispatch already sealed.
    await run('heimr', ['work', 'set', workspace, '--from', '/dev/stdin'], {
      stdin: await renderTemplate('review', reviewTokens(input.ticket, repo, branch)),
    });
    if (isNewWorkspace) {
      await run('heimr', ['repo', 'prepare', workspace, '--from', buildRepo]);
    }
    if (!isSealed(path, 'review')) {
      await sealDispatch(workspace, path, 'review', {
        'container-context.md': await containerContext(),
        'target.diff': diff,
      });
    }
    await run('heimr', ['check', workspace]);
    return { workspace, workspacePath: path, dispatch: 'review', branch };
  }),
});

// What a build round's active dispatch is *right now*: the primary (`build`/`rework-N`) if no
// sealed continuation of it exists yet, otherwise the highest-numbered sealed `*-continue-N`.
// Derived from disk every call, so a brand-new process (a respawn, not a replay) resumes the
// same attempt count a prior process left off at instead of re-using attempt 0 and risking a
// dispatch name collision with a continuation the prior process already sealed.
// `nextStaged` means `styrir signal rework` has already put a note into the next continuation.
export const heimrActiveDispatch = hatchet.task({
  name: 'heimr-active-dispatch',
  fn: logged(async (input: { workspacePath: string; primary: string }): Promise<{ dispatch: string; attempt: number; nextStaged: boolean }> => {
    const attempt = latestAttempt(input.workspacePath, input.primary);
    const next = continuationDispatchName(input.primary, attempt + 1);
    return {
      dispatch: attempt > 0 ? continuationDispatchName(input.primary, attempt) : input.primary,
      attempt,
      nextStaged: existsSync(`${input.workspacePath}/dispatches/${next}`),
    };
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
    const rounds = listSealedDispatches(path)
      .map(parsePrimaryRound)
      .filter((r): r is number => r !== null)
      .sort((a, b) => a - b);
    return { workspace, workspacePath: path, rounds };
  }),
});

// The build dispatch that runs next, so `styrir signal rework` can stage a human note into it
// before it exists. If the active dispatch's handoff is complete, that is the next round's
// primary; otherwise the round is unfinished (escalated, partial, or never handed off) and the
// note goes into its next continuation. `resolveEntryState` and `buildPhase` make the same
// choice, so the note lands in the dispatch that is actually sealed next.
export async function nextBuildDispatch(ticketId: string): Promise<{ workspace: string; workspacePath: string; dispatch: string }> {
  const workspace = `${ticketId}-build`;
  const workspacePath = await resolveWorkspacePath(workspace);
  if (!existsSync(`${workspacePath}/WORK.md`)) {
    throw new Error(`no build workspace for ${ticketId} yet; nothing to rework`);
  }
  const round = highestSealedRound(workspacePath);
  if (round === 0) return { workspace, workspacePath, dispatch: primaryDispatchName(1) };
  const primary = primaryDispatchName(round);
  const attempt = latestAttempt(workspacePath, primary);
  const active = attempt > 0 ? continuationDispatchName(primary, attempt) : primary;
  let status: string | undefined;
  try {
    status = (JSON.parse((await run('heimr', ['dispatch', 'handoff', workspace, active])).stdout) as BuildHandoff).status;
  } catch {
    status = undefined;
  }
  const dispatch = status === 'complete' ? primaryDispatchName(round + 1) : continuationDispatchName(primary, attempt + 1);
  return { workspace, workspacePath, dispatch };
}

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
