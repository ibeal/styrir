import type { JsonObject } from '@hatchet-dev/typescript-sdk';
import { existsSync } from 'node:fs';
import { hatchet } from '../client.js';
import { run } from '../exec.js';
import { repoConfig } from '../config.js';
import type { Ticket } from './skald.js';

export type Finding = {
  severity: 'blocking' | 'should-fix' | 'nit' | 'note' | string;
  description: string;
  path?: string;
  line?: number;
};

async function workspacePath(workspace: string): Promise<string> {
  const { stdout } = await run('heimr', ['path', workspace]);
  return stdout.trim();
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

function buildWorkMd(ticket: Ticket, verify: string): string {
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
- A draft PR opened with \`gh pr create --draft\` (body ≤ 10 lines: one sentence, ≤ 4 bullets, one "Verified:" line).
- HANDOFF.json kept current, shape:
  \`{"version":1,"status":"complete"|"partial","branch":"…","commit":"…","pr":"<url>|null","summary":"…","acceptance_criteria":[{"criterion":"…","status":"done"|"partial"|"not-started","evidence":"…"}],"blockers":["…"]}\`
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
  fn: async (input: {
    ticket: Ticket;
    dispatch: string;
    findings?: Finding[];
    continuation?: string;
  }): Promise<{ workspace: string; workspacePath: string; dispatch: string }> => {
    const repo = repoConfig(input.ticket.repo);
    const workspace = `${input.ticket.id}-build`;
    // `heimr path` answers for a workspace that does not exist yet, so probe the directory.
    const path = await workspacePath(workspace);
    if (!existsSync(`${path}/WORK.md`)) {
      await run('heimr', ['new', workspace]);
      await run('heimr', ['work', 'set', workspace, '--from', '/dev/stdin'], {
        stdin: buildWorkMd(input.ticket, repo.verify),
      });
      await run('heimr', ['repo', 'prepare', workspace, '--from', repo.checkout]);
      await run('heimr', ['repo', 'set-push-remote', workspace, '--url', repo.pushUrl]);
    }

    const inputs: Record<string, string> = { 'container-context.md': await containerContext() };
    if (input.findings?.length) inputs['review-findings.md'] = findingsMarkdown(input.findings);
    if (input.continuation) inputs['continue.md'] = input.continuation;
    await sealDispatch(workspace, input.dispatch, inputs);

    await run('heimr', ['check', workspace]);
    return { workspace, workspacePath: path, dispatch: input.dispatch };
  },
});

// Fresh eyes: always a new workspace, prepared from the build worktree (which sits at the
// branch tip), with only the AC, the diff, and the checklist. Never a build dispatch file.
export const heimrPrepareReview = hatchet.task({
  name: 'heimr-prepare-review',
  retries: 1,
  fn: async (input: {
    ticket: Ticket;
    round: number;
    buildWorkspacePath: string;
  }): Promise<{ workspace: string; workspacePath: string; dispatch: string; branch: string }> => {
    const repo = repoConfig(input.ticket.repo);
    const buildRepo = `${input.buildWorkspacePath}/repository`;
    if (!existsSync(buildRepo)) throw new Error(`no repository at ${buildRepo}`);

    const { stdout: branchOut } = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: buildRepo });
    const branch = branchOut.trim();
    const { stdout: diff } = await run('git', ['diff', `${repo.trunk}...HEAD`], { cwd: buildRepo });
    if (!diff.trim()) throw new Error(`empty diff between ${repo.trunk} and ${branch} in ${buildRepo}`);

    const workspace = `${input.ticket.id}-review-${input.round}`;
    await run('heimr', ['new', workspace]);
    await run('heimr', ['work', 'set', workspace, '--from', '/dev/stdin'], {
      stdin: reviewWorkMd(input.ticket, branch),
    });
    await run('heimr', ['repo', 'prepare', workspace, '--from', buildRepo]);
    await sealDispatch(workspace, 'review', {
      'container-context.md': await containerContext(),
      'target.diff': diff,
    });
    await run('heimr', ['check', workspace]);
    return { workspace, workspacePath: await workspacePath(workspace), dispatch: 'review', branch };
  },
});

export type BuildHandoff = {
  version: number;
  status: 'complete' | 'partial' | string;
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

export const heimrHandoff = hatchet.task({
  name: 'heimr-handoff',
  retries: 1,
  fn: async (input: { workspace: string; dispatch: string }): Promise<{ handoff: JsonObject | null }> => {
    try {
      const { stdout } = await run('heimr', ['dispatch', 'handoff', input.workspace, input.dispatch]);
      return { handoff: JSON.parse(stdout) };
    } catch (err) {
      // A worker that died before writing a handoff is a reconcile case, not a crash.
      return { handoff: null };
    }
  },
});

// What the sandbox left behind, independently of what it claimed.
export const gitReconcile = hatchet.task({
  name: 'git-reconcile',
  fn: async (input: { workspacePath: string; trunk: string }) => {
    const cwd = `${input.workspacePath}/repository`;
    const branch = (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })).stdout.trim();
    const dirty = (await run('git', ['status', '--porcelain'], { cwd })).stdout.trim() !== '';
    const ahead = Number((await run('git', ['rev-list', '--count', `${input.trunk}..HEAD`], { cwd })).stdout.trim());
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
  },
});
