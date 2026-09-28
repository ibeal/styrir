import type { DurableContext } from '@hatchet-dev/typescript-sdk';
import { hatchet } from '../client.js';
import { repoConfig } from '../config.js';
import { heimrHandoff, heimrPrepareReview, type Finding, type ReviewHandoff } from '../tasks/heimr.js';
import { skaldLog, type Ticket } from '../tasks/skald.js';
import { sandboxRun } from './sandbox-run.js';

export type ReviewPhaseInput = {
  ticket: Ticket;
  round: number;
  buildWorkspacePath: string;
};

export type ReviewPhaseOutput = {
  verdict: 'approve' | 'request-changes' | 'inconclusive';
  findings: Finding[];
  actionable: Finding[]; // blocking + should-fix
  summary: string;
};

// Fresh eyes: a new workspace per round, prepared at the branch tip, fed the diff + AC +
// checklist and nothing from the build. The verdict is derived from severities, never trusted.
export const reviewPhase = hatchet.durableTask({
  name: 'review-phase',
  executionTimeout: '12h',
  fn: async (input: ReviewPhaseInput, ctx: DurableContext<ReviewPhaseInput>): Promise<ReviewPhaseOutput> => {
    const { ticket } = input;
    const repo = repoConfig(ticket.repo);

    const prepared = await heimrPrepareReview.run({
      ticket,
      round: input.round,
      buildWorkspacePath: input.buildWorkspacePath,
    });

    // A respawned run may find this round's review already ran to completion in a prior
    // process (dispatch sealed, handoff written): never re-run gardr against a diff already
    // judged — that is what makes the review round number safe to derive and reuse on respawn.
    let handoff = (await heimrHandoff.run({ workspace: prepared.workspace, dispatch: prepared.dispatch })).handoff as ReviewHandoff | null;
    let runId = 'skipped; prior review already complete';
    let stderrTail = '';
    if (!handoff || handoff.status !== 'complete') {
      const result = await sandboxRun.run({
        workspace: prepared.workspace,
        workspacePath: prepared.workspacePath,
        dispatch: prepared.dispatch,
        spec: repo.reviewSpec,
        kind: 'review',
        ticketId: ticket.id,
        repo: ticket.repo,
        complexity: ticket.complexity,
        provider: ticket.provider,
      });
      runId = result.runId;
      handoff = result.handoff as ReviewHandoff | null;
      stderrTail = result.stderrTail;
    }

    const findings = handoff?.findings ?? [];
    const actionable = findings.filter((f) => f.severity === 'blocking' || f.severity === 'should-fix');

    let verdict: ReviewPhaseOutput['verdict'];
    if (!handoff || handoff.status !== 'complete') verdict = 'inconclusive';
    else verdict = actionable.length ? 'request-changes' : 'approve';

    const summary =
      handoff?.summary ??
      `review run ${runId} left no complete handoff` +
        (stderrTail ? `\n\ngardr stderr:\n\`\`\`\n${stderrTail}\n\`\`\`` : '');
    await skaldLog.run({
      ticketId: ticket.id,
      entry:
        `review round ${input.round} (gardr ${runId}, workspace ${prepared.workspace}): ${verdict}\n\n${summary}\n\n` +
        (findings.length
          ? findings.map((f) => `- ${f.severity}${f.path ? ` ${f.path}${f.line ? `:${f.line}` : ''}` : ''}: ${f.description}`).join('\n')
          : '- no findings'),
    });

    return { verdict, findings, actionable, summary };
  },
});
