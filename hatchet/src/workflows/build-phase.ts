import type { DurableContext } from '@hatchet-dev/typescript-sdk';
import { hatchet } from '../client.js';
import { config, repoConfig } from '../config.js';
import { gitReconcile, heimrPrepareBuild, type BuildHandoff, type Finding } from '../tasks/heimr.js';
import { skaldLog, skaldSet, type Ticket } from '../tasks/skald.js';
import { sandboxRun } from './sandbox-run.js';

export type BuildPhaseInput = {
  ticket: Ticket;
  round: number; // 1 = first build; >1 = rework after review round-1
  findings?: Finding[];
};

export type BuildPhaseOutput = {
  ok: boolean;
  workspace: string;
  workspacePath: string;
  branch: string | null;
  pr: string | null;
  reason: string | null;
};

function unmet(handoff: BuildHandoff | null): string[] {
  if (!handoff) return ['no HANDOFF.json'];
  const out: string[] = [];
  if (handoff.status !== 'complete') out.push(`handoff status ${handoff.status}`);
  for (const ac of handoff.acceptance_criteria ?? []) {
    if (ac.status !== 'done') out.push(`AC ${ac.status}: ${ac.criterion}`);
  }
  for (const b of handoff.blockers ?? []) out.push(`blocker: ${b}`);
  return out;
}

// Exit 0 is not completion. Every run is reconciled against git and the handoff, and a
// mid-flight worker is continued in the same workspace rather than redispatched cold.
export const buildPhase = hatchet.durableTask({
  name: 'build-phase',
  executionTimeout: '24h',
  fn: async (input: BuildPhaseInput, ctx: DurableContext<BuildPhaseInput>): Promise<BuildPhaseOutput> => {
    const { ticket } = input;
    const repo = repoConfig(ticket.repo);

    let dispatch = input.round === 1 ? 'build' : `rework-${input.round}`;
    let prepared = await heimrPrepareBuild.run({ ticket, dispatch, findings: input.findings });
    await skaldLog.run({
      ticketId: ticket.id,
      entry: `build round ${input.round}: sealed dispatch ${dispatch} in heimr workspace ${prepared.workspace}`,
    });

    for (let attempt = 0; ; attempt++) {
      const result = await sandboxRun.run({
        workspace: prepared.workspace,
        workspacePath: prepared.workspacePath,
        dispatch,
        spec: repo.buildSpec,
        kind: 'build',
      });
      const handoff = result.handoff as BuildHandoff | null;
      const git = await gitReconcile.run({ workspacePath: prepared.workspacePath, trunk: repo.trunk });

      const problems = unmet(handoff);
      if (git.onTrunk) problems.push(`still on ${repo.trunk}`);
      if (git.ahead === 0) problems.push('no commits ahead of trunk');
      if (git.dirty) problems.push('worktree dirty');
      if (!git.pushed) problems.push('branch not pushed');
      if (!handoff?.pr) problems.push('no PR in handoff');
      if (result.exitStatus !== 0) problems.push(`gardr exit ${result.exitStatus}${result.failure ? `: ${result.failure}` : ''}`);

      await skaldLog.run({
        ticketId: ticket.id,
        entry:
          `build round ${input.round} attempt ${attempt + 1} (gardr ${result.runId}): ` +
          (problems.length ? `incomplete — ${problems.join('; ')}` : `complete — ${handoff?.summary ?? ''}`),
      });

      if (problems.length === 0) {
        await skaldSet.run({
          ticketId: ticket.id,
          status: 'reviewing',
          branch: git.branch,
          pr: handoff!.pr!,
        });
        return { ok: true, workspace: prepared.workspace, workspacePath: prepared.workspacePath, branch: git.branch, pr: handoff!.pr!, reason: null };
      }

      if (attempt >= config.maxBuildContinuations) {
        return {
          ok: false,
          workspace: prepared.workspace,
          workspacePath: prepared.workspacePath,
          branch: git.onTrunk ? null : git.branch,
          pr: handoff?.pr ?? null,
          reason: problems.join('; '),
        };
      }

      dispatch = `${input.round === 1 ? 'build' : `rework-${input.round}`}-continue-${attempt + 1}`;
      prepared = await heimrPrepareBuild.run({
        ticket,
        dispatch,
        continuation:
          `# Continue\n\nThe previous run ended before the task was complete. Surviving work is on branch ` +
          `\`${git.branch}\` in this worktree (${git.ahead} commit(s) ahead of ${repo.trunk}` +
          `${git.dirty ? ', uncommitted changes present' : ''}). Outstanding:\n\n` +
          problems.map((p) => `- ${p}`).join('\n') +
          `\n\nFinish these, run verification, commit, push, ensure the PR exists, and update HANDOFF.json.\n`,
      });
    }
  },
});
