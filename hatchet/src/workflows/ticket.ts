import { NonRetryableError } from '@hatchet-dev/typescript-sdk';
import type { DurableContext } from '@hatchet-dev/typescript-sdk';
import { z } from 'zod/v4';
import { hatchet } from '../client.js';
import { config } from '../config.js';
import type { Finding } from '../tasks/heimr.js';
import { skaldLog, skaldRead, skaldSet } from '../tasks/skald.js';
import { buildPhase } from './build-phase.js';
import { reviewPhase } from './review-phase.js';

export const TICKET_SIGNAL_EVENT = 'ticket:signal';

export const ticketSignalSchema = z.object({
  ticketId: z.string(),
  action: z.enum(['merged', 'rework', 'cancel']),
  note: z.string().optional(),
});
export type TicketSignal = z.infer<typeof ticketSignalSchema>;

export type TicketInput = { ticketId: string };
export type TicketOutput = { ticketId: string; outcome: 'done' | 'cancelled' | 'paused'; reason: string | null };

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

    const pause = async (reason: string): Promise<TicketOutput> => {
      await skaldSet.run({ ticketId, paused: reason });
      await skaldLog.run({ ticketId, entry: `hatchet: paused — ${reason}` });
      return { ticketId, outcome: 'paused', reason };
    };

    let round = 1;
    let findings: Finding[] | undefined;
    let buildWorkspacePath: string | null = null;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const build = await buildPhase.run({ ticket, round, findings });
      buildWorkspacePath = build.workspacePath;
      if (!build.ok) return pause(`build round ${round} incomplete after continuations: ${build.reason}`);

      const review = await reviewPhase.run({ ticket, round, buildWorkspacePath });
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

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const signal = await ctx.waitForEvent(
        TICKET_SIGNAL_EVENT,
        `input.ticketId == '${ticketId}'`,
        ticketSignalSchema,
        `ticket:${ticketId}`,
        '1h',
      );

      if (signal.action === 'merged') {
        await skaldSet.run({ ticketId, status: 'done', paused: '' });
        await skaldLog.run({ ticketId, entry: `hatchet: merged${signal.note ? ` — ${signal.note}` : ''}` });
        return { ticketId, outcome: 'done', reason: null };
      }
      if (signal.action === 'cancel') {
        await skaldSet.run({ ticketId, status: 'cancelled', paused: '' });
        await skaldLog.run({ ticketId, entry: `hatchet: cancelled${signal.note ? ` — ${signal.note}` : ''}` });
        return { ticketId, outcome: 'cancelled', reason: signal.note ?? null };
      }

      // rework: one more build round from the human's note, then fresh eyes again
      await skaldSet.run({ ticketId, paused: '' });
      round += 1;
      const build = await buildPhase.run({
        ticket,
        round,
        findings: [{ severity: 'should-fix', description: signal.note ?? 'rework requested by Ian' }],
      });
      if (!build.ok) return pause(`rework round ${round} incomplete: ${build.reason}`);
      const review = await reviewPhase.run({ ticket, round, buildWorkspacePath: build.workspacePath });
      if (review.verdict !== 'approve') {
        return pause(`rework round ${round} review: ${review.verdict} (${review.actionable.length} actionable)`);
      }
      await skaldSet.run({ ticketId, paused: 'review clean; waiting on Ian to publish/merge' });
    }
  },
});
