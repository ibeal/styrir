import type { Context } from '@hatchet-dev/typescript-sdk';
import { IdempotencyCollisionError } from '@hatchet-dev/typescript-sdk';
import { hatchet } from '../client.js';
import { skaldListBuilding } from '../tasks/skald.js';
import { sdlcTicket } from './ticket.js';

// Replaces `styrir serve`: skald is the queue. A ticket that already has a live sdlc-ticket
// run collides on its idempotency key; that is the expected steady state, not a failure.
export const pollSkald = hatchet.task({
  name: 'sdlc-poll-skald',
  onCrons: ['*/3 * * * *'],
  fn: async (_input: {}, ctx: Context<{}>) => {
    const { ticketIds } = await skaldListBuilding.run({});
    const spawned: string[] = [];
    const alreadyRunning: string[] = [];
    for (const ticketId of ticketIds) {
      try {
        await sdlcTicket.runNoWait({ ticketId });
        spawned.push(ticketId);
        await ctx.logger.info(`spawned sdlc-ticket for ${ticketId}`);
      } catch (err) {
        if (!(err instanceof IdempotencyCollisionError)) throw err;
        alreadyRunning.push(ticketId);
      }
    }
    await ctx.logger.info(`${ticketIds.length} unpaused building/reviewing ticket(s): ${spawned.length} spawned, ${alreadyRunning.length} already running`);
    return { spawned, alreadyRunning };
  },
});
