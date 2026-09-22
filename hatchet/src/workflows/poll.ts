import type { Context } from '@hatchet-dev/typescript-sdk';
import { hatchet } from '../client.js';
import { skaldListBuilding } from '../tasks/skald.js';
import { sdlcTicket } from './ticket.js';

// Replaces `styrir serve`: skald is the queue. Duplicate spawns are dropped by
// sdlc-ticket's status-based idempotency, so this can fire as often as it likes.
export const pollSkald = hatchet.task({
  name: 'sdlc-poll-skald',
  onCrons: ['*/5 * * * *'],
  fn: async (_input: {}, ctx: Context<{}>) => {
    const { ticketIds } = await skaldListBuilding.run({});
    for (const ticketId of ticketIds) {
      await sdlcTicket.runNoWait({ ticketId });
    }
    return { spawned: ticketIds };
  },
});
