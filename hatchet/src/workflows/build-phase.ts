import type { DurableContext } from '@hatchet-dev/typescript-sdk';
import { hatchet } from '../client.js';
import { config, repoConfig } from '../config.js';
import {
  buildProblems,
  gitReconcile,
  heimrActiveDispatch,
  heimrHandoff,
  heimrPrepareBuild,
  continuationDispatchName,
  primaryDispatchName,
  type BuildHandoff,
} from '../tasks/heimr.js';
import { skaldLog, skaldRead, skaldSet, type Ticket } from '../tasks/skald.js';
import { sandboxRun } from './sandbox-run.js';
import { decideBuildStep, survivingWork } from './build-phase-logic.js';

export { sameProblems, survivingWork, decideBuildStep, type BuildStepDecision } from './build-phase-logic.js';
// The plain functions above have no hatchet-client dependency, so tests import them from
// `build-phase-logic.js` directly; this re-export just keeps `build-phase.ts` the single place
// other workflow code imports the build-phase surface from.

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
    // The same fresh read also drives model selection, so a complexity/provider change applies
    // from the next dispatch rather than the next workflow run.
    let fresh = await skaldRead.run({ ticketId: ticket.id });
    let prepared = await heimrPrepareBuild.run({ ticket: fresh, dispatch: primary });
    await skaldLog.run({
      ticketId: ticket.id,
      entry: `build round ${input.round}: sealed dispatch ${primary} in heimr workspace ${prepared.workspace}`,
    });

    // A fresh process (a respawn, not a replay) has no memory of how many continuation attempts
    // this round already made; derive the active dispatch and attempt count from disk so a new
    // continuation never reuses a name a prior process already sealed.
    const active = await heimrActiveDispatch.run({ workspacePath: prepared.workspacePath, primary });
    let dispatch = active.dispatch;

    // The previous (non-human-resumed) attempt's problem set, so a continuation that ends with
    // exactly the same problems as the attempt before it is recognized as no progress rather than
    // spent again up to `maxBuildContinuations`. A human-resumed attempt resets it: the human's
    // answer is new information, not a repeat.
    let previousProblems: string[] | null = null;

    for (let attempt = active.attempt; ; attempt++) {
      // Reconcile before spending a sandbox: a respawned run whose worker already finished
      // (or a dispatch sealed by a previous, failed run) must not build twice.
      let handoff = (await heimrHandoff.run({ workspace: prepared.workspace, dispatch })).handoff as BuildHandoff | null;
      let git = await gitReconcile.run({ workspacePath: prepared.workspacePath, trunk: repo.trunk });
      let problems = buildProblems(handoff, git, repo.trunk);
      let runId = 'skipped; prior run already complete';

      // A human has answered this round's active dispatch: either a rework note is already staged
      // into the next continuation, or the active dispatch escalated and the ticket was sent back
      // to building. Running that dispatch again would replay the question, not the answer, so
      // seal the next continuation instead. The attempt cap does not apply to a human's answer.
      const humanResumed =
        attempt === active.attempt && (active.nextStaged || handoff?.status === 'escalated');

      if (humanResumed) {
        await skaldLog.run({
          ticketId: ticket.id,
          entry:
            `build round ${input.round}: ${dispatch} ${active.nextStaged ? 'has a staged note in the next continuation' : 'escalated earlier'}; ` +
            `sealing ${continuationDispatchName(primary, attempt + 1)} instead of rerunning it`,
        });
      } else if (problems.length > 0) {
        const result = await sandboxRun.run({
          workspace: prepared.workspace,
          workspacePath: prepared.workspacePath,
          dispatch,
          spec: repo.buildSpec,
          kind: 'build',
          ticketId: ticket.id,
          repo: ticket.repo,
          complexity: fresh.complexity,
          provider: fresh.provider,
        });
        runId = result.runId;
        handoff = result.handoff as BuildHandoff | null;
        git = await gitReconcile.run({ workspacePath: prepared.workspacePath, trunk: repo.trunk });
        problems = buildProblems(handoff, git, repo.trunk);
        if (result.exitStatus !== 0) problems.push(`gardr exit ${result.exitStatus}${result.failure ? `: ${result.failure}` : ''}`);
        if (!handoff && result.stderrTail) problems.push(`gardr stderr: ${result.stderrTail}`);
      }

      if (!humanResumed) {
        await skaldLog.run({
          ticketId: ticket.id,
          entry:
            `build round ${input.round} attempt ${attempt + 1} (gardr ${runId}): ` +
            (problems.length ? `incomplete — ${problems.join('; ')}` : `complete — ${handoff?.summary ?? ''}`),
        });
      }

      const decision = decideBuildStep({
        humanResumed,
        handoffStatus: handoff?.status,
        escalationReason: handoff?.escalation ?? handoff?.summary ?? 'no reason given',
        problems,
        previousProblems,
        attempt,
        maxContinuations: config.maxBuildContinuations,
      });

      // The worker may decide a blocker is outside its scope. That is a refining problem, not
      // something to retry: hand the ticket back with the reason and stop.
      if (decision.action === 'escalate-worker') {
        await skaldSet.run({
          ticketId: ticket.id,
          status: 'refining',
          paused: 'escalated by build worker; waiting for human review',
          ...survivingWork(git, handoff),
        });
        await skaldLog.run({
          ticketId: ticket.id,
          entry: `build round ${input.round} attempt ${attempt + 1} (gardr ${runId}): escalated to refining — ${decision.reason}`,
        });
        return { ok: false, escalated: true, workspace: prepared.workspace, workspacePath: prepared.workspacePath, branch: git.onTrunk ? null : git.branch, pr: handoff?.pr ?? null, reason: decision.reason };
      }

      if (decision.action === 'success') {
        await skaldSet.run({
          ticketId: ticket.id,
          status: 'reviewing',
          branch: git.branch,
          pr: handoff!.pr!,
        });
        return { ok: true, escalated: false, workspace: prepared.workspace, workspacePath: prepared.workspacePath, branch: git.branch, pr: handoff!.pr!, reason: null };
      }

      // A continuation that ends with the same problems as the attempt before it is not making
      // progress that another continuation would fix — treat it like a worker escalation instead
      // of running up to `maxBuildContinuations`.
      if (decision.action === 'escalate-no-progress') {
        await skaldSet.run({
          ticketId: ticket.id,
          status: 'refining',
          paused: 'no progress across build continuations; waiting for human review',
          ...survivingWork(git, handoff),
        });
        await skaldLog.run({
          ticketId: ticket.id,
          entry: `build round ${input.round} attempt ${attempt + 1} (gardr ${runId}): escalated to refining — ${decision.reason}`,
        });
        return { ok: false, escalated: true, workspace: prepared.workspace, workspacePath: prepared.workspacePath, branch: git.onTrunk ? null : git.branch, pr: handoff?.pr ?? null, reason: decision.reason };
      }

      if (decision.action === 'max-continuations') {
        const persist = survivingWork(git, handoff);
        if (persist.branch !== undefined || persist.pr !== undefined) {
          await skaldSet.run({ ticketId: ticket.id, ...persist });
        }
        return {
          ok: false,
          escalated: false,
          workspace: prepared.workspace,
          workspacePath: prepared.workspacePath,
          branch: git.onTrunk ? null : git.branch,
          pr: handoff?.pr ?? null,
          reason: decision.reason,
        };
      }

      previousProblems = humanResumed ? null : problems;

      dispatch = continuationDispatchName(primary, attempt + 1);
      fresh = await skaldRead.run({ ticketId: ticket.id });
      prepared = await heimrPrepareBuild.run({
        ticket: fresh,
        dispatch,
        continuation:
          `# Continue\n\nThe previous run ended before the task was complete. Surviving work is on branch ` +
          `\`${git.branch}\` in this worktree (${git.ahead} commit(s) ahead of ${repo.trunk}` +
          `${git.dirty ? ', uncommitted changes present' : ''}). Outstanding:\n\n` +
          problems.map((p) => `- ${p}`).join('\n') +
          (humanResumed ? `\n\nA human has responded to the previous run; read everything under \`inbox/\` first.` : '') +
          `\n\nFinish these, run verification, commit, push, ensure the PR exists, and update HANDOFF.json. ` +
          `See \`escalation-policy.md\` if a blocker turns out to be outside this task's scope.\n`,
      });
    }
  },
});
