import { NonRetryableError } from '@hatchet-dev/typescript-sdk';
import type { DurableContext } from '@hatchet-dev/typescript-sdk';
import { z } from 'zod/v4';
import { hatchet } from '../client.js';
import { config, repoConfig } from '../config.js';
import {
  buildProblems,
  gitReconcile,
  heimrActiveDispatch,
  heimrBuildRounds,
  heimrHandoff,
  heimrResolveRework,
  primaryDispatchName,
  type BuildHandoff,
  type Finding,
} from '../tasks/heimr.js';
import { skaldLog, skaldRead, skaldSet, type Ticket } from '../tasks/skald.js';
import { buildPhase } from './build-phase.js';
import { reviewPhase } from './review-phase.js';

export const TICKET_SIGNAL_EVENT = 'ticket:signal';

export const ticketSignalSchema = z.object({
  ticketId: z.string(),
  action: z.enum(['merged', 'rework', 'cancel']),
  note: z.string().optional(),
});
export type TicketSignal = z.infer<typeof ticketSignalSchema>;

export const TICKET_PROGRESS_EVENT = 'sdlc:ticket';

// A timeline entry on the Events page, filterable by ticketId. Fired from the durable body,
// so a replay after eviction may repeat one; the timeline is for eyes, not for triggering.
async function emit(ticketId: string, phase: string, detail: Record<string, unknown> = {}): Promise<void> {
  await hatchet.events
    .push(TICKET_PROGRESS_EVENT, { ticketId, phase, ...detail }, { additionalMetadata: { ticketId, phase } })
    .catch(() => {});
}

export type TicketInput = { ticketId: string };
export type TicketOutput = { ticketId: string; outcome: 'done' | 'cancelled' | 'paused' | 'escalated'; reason: string | null };

type EntryState = {
  mode: 'first-build' | 'continue' | 'rework' | 'review-only';
  round: number;
  findings: Finding[] | undefined;
  buildWorkspacePath: string | null;
  reason: string;
};

// Skald status and the heimr build workspace are the durable record of where a ticket's
// building/reviewing life actually is; the round number and rework findings must be derived from
// them every time a run starts, never carried only in a local variable. A prior process's local
// state (an in-memory `round`, a signal's `note`) is gone the moment it exits, but a respawn from
// the poll cron is a brand-new process with no memory of it — only the filesystem survived.
async function resolveEntryState(ticket: Ticket): Promise<EntryState> {
  const repo = repoConfig(ticket.repo);
  const rounds = await heimrBuildRounds.run({ ticketId: ticket.id });

  if (rounds.workspacePath === null || rounds.rounds.length === 0) {
    return { mode: 'first-build', round: 1, findings: undefined, buildWorkspacePath: null, reason: 'no prior build workspace' };
  }

  const highestRound = rounds.rounds[rounds.rounds.length - 1];
  const primary = primaryDispatchName(highestRound);
  const active = await heimrActiveDispatch.run({ workspacePath: rounds.workspacePath, primary });
  const handoff = (await heimrHandoff.run({ workspace: rounds.workspace, dispatch: active.dispatch })).handoff as BuildHandoff | null;
  const git = await gitReconcile.run({ workspacePath: rounds.workspacePath, trunk: repo.trunk });
  const problems = buildProblems(handoff, git, repo.trunk);

  if (ticket.status === 'reviewing') {
    return {
      mode: 'review-only',
      round: highestRound,
      findings: undefined,
      buildWorkspacePath: rounds.workspacePath,
      reason: `round ${highestRound}'s build is complete and the ticket is already reviewing`,
    };
  }

  if (problems.length > 0) {
    return {
      mode: 'continue',
      round: highestRound,
      findings: undefined,
      buildWorkspacePath: rounds.workspacePath,
      reason: `round ${highestRound}'s build is incomplete (${problems.join('; ')}); resuming it in place`,
    };
  }

  // The active dispatch is done (clean, pushed, PR, handoff complete) yet the ticket is back at
  // `building` — that only happens when something sent it back for another pass. This round is
  // done; the next one starts here, fed by whatever durable record explains why.
  const rework = await heimrResolveRework.run({ ticketId: ticket.id, buildWorkspacePath: rounds.workspacePath, completedRound: highestRound });
  return {
    mode: 'rework',
    round: highestRound + 1,
    findings: rework.findings,
    buildWorkspacePath: rounds.workspacePath,
    reason: `round ${highestRound}'s build was already complete but the ticket is building again; starting round ${highestRound + 1} with ${rework.findings.length} durable finding(s)`,
  };
}

// One durable run per ticket for its whole building → reviewing → done life. It only
// spawns children and waits, so it is safe to evict and replay at every checkpoint.
export const sdlcTicket = hatchet.durableTask({
  name: 'sdlc-ticket',
  executionTimeout: '720h',
  idempotency: {
    strategy: 'status',
    expression: 'input.ticketId',
    fallbackTtlMs: 30 * 24 * 60 * 60 * 1000,
  },
  fn: async (input: TicketInput, ctx: DurableContext<TicketInput>): Promise<TicketOutput> => {
    const { ticketId } = input;
    const ticket = await skaldRead.run({ ticketId });

    if (ticket.status !== 'building' && ticket.status !== 'reviewing') {
      throw new NonRetryableError(`${ticketId} is ${ticket.status}; this workflow owns building and reviewing only`);
    }
    if (ticket.paused) {
      throw new NonRetryableError(`${ticketId} is paused: ${ticket.paused}`);
    }

    await emit(ticketId, 'started', { status: ticket.status, repo: ticket.repo });

    const pause = async (reason: string): Promise<TicketOutput> => {
      await skaldSet.run({ ticketId, paused: reason });
      await skaldLog.run({ ticketId, entry: `hatchet: paused — ${reason}` });
      await emit(ticketId, 'paused', { reason });
      return { ticketId, outcome: 'paused', reason };
    };

    const entry = await resolveEntryState(ticket);
    await skaldLog.run({ ticketId, entry: `hatchet: resumed — mode ${entry.mode} (round ${entry.round}): ${entry.reason}` });

    let round = entry.round;
    let findings = entry.findings;
    let buildWorkspacePath: string | null = entry.buildWorkspacePath;
    let skipBuild = entry.mode === 'review-only';

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (!skipBuild) {
        await emit(ticketId, 'build', { round });
        const build = await buildPhase.run({ ticket, round, findings });
        buildWorkspacePath = build.workspacePath;
        await emit(ticketId, build.escalated ? 'escalated' : build.ok ? 'built' : 'build-incomplete', { round, branch: build.branch, pr: build.pr, reason: build.reason });
        if (build.escalated) return { ticketId, outcome: 'escalated', reason: build.reason };
        if (!build.ok) return pause(`build round ${round} incomplete after continuations: ${build.reason}`);
      }
      skipBuild = false;

      await emit(ticketId, 'review', { round });
      const review = await reviewPhase.run({ ticket, round, buildWorkspacePath: buildWorkspacePath! });
      await emit(ticketId, 'reviewed', { round, verdict: review.verdict, actionable: review.actionable.length });
      if (review.verdict === 'inconclusive') return pause(`review round ${round} left no usable handoff`);
      if (review.verdict === 'approve') break;

      if (round >= config.maxReviewRounds) {
        return pause(`review round cap (${config.maxReviewRounds}) hit with ${review.actionable.length} actionable finding(s)`);
      }
      round += 1;
      findings = review.actionable;
    }

    // Publishing and merging are the human boundary. Park the ticket and wait for the signal.
    await skaldSet.run({ ticketId, paused: 'review clean; waiting on Ian to publish/merge' });
    await skaldLog.run({
      ticketId,
      entry: `hatchet: review clean after ${round} round(s). Awaiting \`styrir signal ${ticketId} merged|rework|cancel\`.`,
    });
    await emit(ticketId, 'awaiting-signal', { round });

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const signal = await ctx.waitForEvent(
        TICKET_SIGNAL_EVENT,
        `input.ticketId == '${ticketId}'`,
        ticketSignalSchema,
        `ticket:${ticketId}`,
        '1h',
      );

      await emit(ticketId, 'signal', { action: signal.action, note: signal.note });
      if (signal.action === 'merged') {
        await skaldSet.run({ ticketId, status: 'done', paused: '' });
        await skaldLog.run({ ticketId, entry: `hatchet: merged${signal.note ? ` — ${signal.note}` : ''}` });
        await emit(ticketId, 'done');
        return { ticketId, outcome: 'done', reason: null };
      }
      if (signal.action === 'cancel') {
        await skaldSet.run({ ticketId, status: 'cancelled', paused: '' });
        await skaldLog.run({ ticketId, entry: `hatchet: cancelled${signal.note ? ` — ${signal.note}` : ''}` });
        await emit(ticketId, 'cancelled', { note: signal.note });
        return { ticketId, outcome: 'cancelled', reason: signal.note ?? null };
      }

      // rework: one more build round from a durable record — the previous review round's
      // handoff and/or the note `styrir signal rework` left in the build workspace — then fresh
      // eyes again. Never reuse `signal.note` directly: that value only exists for as long as
      // this run does, and this is the same durable source a cold respawn would derive.
      await skaldSet.run({ ticketId, paused: '' });
      const rework = await heimrResolveRework.run({ ticketId: ticket.id, buildWorkspacePath: buildWorkspacePath!, completedRound: round });
      round += 1;
      const build = await buildPhase.run({ ticket, round, findings: rework.findings });
      buildWorkspacePath = build.workspacePath;
      if (build.escalated) return { ticketId, outcome: 'escalated', reason: build.reason };
      if (!build.ok) return pause(`rework round ${round} incomplete: ${build.reason}`);
      const review = await reviewPhase.run({ ticket, round, buildWorkspacePath });
      if (review.verdict !== 'approve') {
        return pause(`rework round ${round} review: ${review.verdict} (${review.actionable.length} actionable)`);
      }
      await skaldSet.run({ ticketId, paused: 'review clean; waiting on Ian to publish/merge' });
    }
  },
});
