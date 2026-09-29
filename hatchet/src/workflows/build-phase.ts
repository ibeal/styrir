import type { DurableContext } from '@hatchet-dev/typescript-sdk';
import { hatchet } from '../client.js';
import { config, repoConfig } from '../config.js';
import {
  buildProblems,
  gitReconcile,
  heimrActiveDispatch,
  heimrHandoff,
  heimrPrepareBuild,
  primaryDispatchName,
  type BuildHandoff,
} from '../tasks/heimr.js';
import { skaldLog, skaldRead, skaldSet, type Ticket } from '../tasks/skald.js';
import { sandboxRun } from './sandbox-run.js';

export type BuildPhaseInput = {
  ticket: Ticket;
  round: number; // 1 = first build; >1 = rework after review round-1
};

export type BuildPhaseOutput = {
  ok: boolean;
  escalated: boolean; // worker sent the ticket back to refining; reason in `reason`
  workspace: string;
  workspacePath: string;
  branch: string | null;
  pr: string | null;
  reason: string | null;
};

// Exit 0 is not completion. Every run is reconciled against git and the handoff, and a
// mid-flight worker is continued in the same workspace rather than redispatched cold.
export const buildPhase = hatchet.durableTask({
  name: 'build-phase',
  executionTimeout: '24h',
  fn: async (input: BuildPhaseInput, ctx: DurableContext<BuildPhaseInput>): Promise<BuildPhaseOutput> => {
    const { ticket } = input;
    const repo = repoConfig(ticket.repo);
    const primary = primaryDispatchName(input.round);

    // Re-read fresh every time a dispatch is prepared, never the object read at run start, so
    // WORK.md reflects the ticket's current AC and `pr` even on a later continuation or rework.
    let prepared = await heimrPrepareBuild.run({ ticket: await skaldRead.run({ ticketId: ticket.id }), dispatch: primary });
    await skaldLog.run({
      ticketId: ticket.id,
      entry: `build round ${input.round}: sealed dispatch ${primary} in heimr workspace ${prepared.workspace}`,
    });

    // A fresh process (a respawn, not a replay) has no memory of how many continuation attempts
    // this round already made; derive the active dispatch and attempt count from disk so a new
    // continuation never reuses a name a prior process already sealed.
    const active = await heimrActiveDispatch.run({ workspacePath: prepared.workspacePath, primary });
    let dispatch = active.dispatch;

    for (let attempt = active.attempt; ; attempt++) {
      // Reconcile before spending a sandbox: a respawned run whose worker already finished
      // (or a dispatch sealed by a previous, failed run) must not build twice.
      let handoff = (await heimrHandoff.run({ workspace: prepared.workspace, dispatch })).handoff as BuildHandoff | null;
      let git = await gitReconcile.run({ workspacePath: prepared.workspacePath, trunk: repo.trunk });
      let problems = buildProblems(handoff, git, repo.trunk);
      let runId = 'skipped; prior run already complete';

      if (problems.length > 0) {
        const result = await sandboxRun.run({
          workspace: prepared.workspace,
          workspacePath: prepared.workspacePath,
          dispatch,
          spec: repo.buildSpec,
          kind: 'build',
          ticketId: ticket.id,
          repo: ticket.repo,
          complexity: ticket.complexity,
          provider: ticket.provider,
        });
        runId = result.runId;
        handoff = result.handoff as BuildHandoff | null;
        git = await gitReconcile.run({ workspacePath: prepared.workspacePath, trunk: repo.trunk });
        problems = buildProblems(handoff, git, repo.trunk);
        if (result.exitStatus !== 0) problems.push(`gardr exit ${result.exitStatus}${result.failure ? `: ${result.failure}` : ''}`);
        if (!handoff && result.stderrTail) problems.push(`gardr stderr: ${result.stderrTail}`);
      }

      // The worker may decide a blocker is outside its scope. That is a refining problem, not
      // something to retry: hand the ticket back with the reason and stop.
      if (handoff?.status === 'escalated') {
        const reason = handoff.escalation ?? handoff.summary ?? 'no reason given';
        await skaldSet.run({
          ticketId: ticket.id,
          status: 'refining',
          paused: 'escalated by build worker; waiting for human review',
          ...(git.onTrunk ? {} : { branch: git.branch }),
        });
        await skaldLog.run({
          ticketId: ticket.id,
          entry: `build round ${input.round} attempt ${attempt + 1} (gardr ${runId}): escalated to refining — ${reason}`,
        });
        return { ok: false, escalated: true, workspace: prepared.workspace, workspacePath: prepared.workspacePath, branch: git.onTrunk ? null : git.branch, pr: handoff.pr ?? null, reason };
      }

      await skaldLog.run({
        ticketId: ticket.id,
        entry:
          `build round ${input.round} attempt ${attempt + 1} (gardr ${runId}): ` +
          (problems.length ? `incomplete — ${problems.join('; ')}` : `complete — ${handoff?.summary ?? ''}`),
      });

      if (problems.length === 0) {
        await skaldSet.run({
          ticketId: ticket.id,
          status: 'reviewing',
          branch: git.branch,
          pr: handoff!.pr!,
        });
        return { ok: true, escalated: false, workspace: prepared.workspace, workspacePath: prepared.workspacePath, branch: git.branch, pr: handoff!.pr!, reason: null };
      }

      if (attempt >= config.maxBuildContinuations) {
        return {
          ok: false,
          escalated: false,
          workspace: prepared.workspace,
          workspacePath: prepared.workspacePath,
          branch: git.onTrunk ? null : git.branch,
          pr: handoff?.pr ?? null,
          reason: problems.join('; '),
        };
      }

      dispatch = `${primary}-continue-${attempt + 1}`;
      prepared = await heimrPrepareBuild.run({
        ticket: await skaldRead.run({ ticketId: ticket.id }),
        dispatch,
        continuation:
          `# Continue\n\nThe previous run ended before the task was complete. Surviving work is on branch ` +
          `\`${git.branch}\` in this worktree (${git.ahead} commit(s) ahead of ${repo.trunk}` +
          `${git.dirty ? ', uncommitted changes present' : ''}). Outstanding:\n\n` +
          problems.map((p) => `- ${p}`).join('\n') +
          `\n\nFinish these, run verification, commit, push, ensure the PR exists, and update HANDOFF.json.\n\n` +
          `If a blocker cannot be resolved within this task's scope (a wrong assumption in the criteria, a decision that ` +
          `belongs to a human, a tool or network policy that makes a criterion impossible here), do not retry: commit and ` +
          `push what is sound, then set \`"status":"escalated"\` and \`"escalation":"<problem and the decision needed>"\` ` +
          `in HANDOFF.json. The ticket returns to refining for a human.\n`,
      });
    }
  },
});
