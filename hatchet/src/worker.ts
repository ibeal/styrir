import { hatchet } from './client.js';
import { gardrCleanup, gardrObserve, gardrStart } from './tasks/gardr.js';
import { gitReconcile, heimrHandoff, heimrPrepareBuild, heimrPrepareReview } from './tasks/heimr.js';
import { skaldListBuilding, skaldLog, skaldRead, skaldSet } from './tasks/skald.js';
import { buildPhase } from './workflows/build-phase.js';
import { pollSkald } from './workflows/poll.js';
import { reviewPhase } from './workflows/review-phase.js';
import { sandboxRun } from './workflows/sandbox-run.js';
import { sdlcTicket } from './workflows/ticket.js';

async function main() {
  const worker = await hatchet.worker('styrir-sdlc', {
    workflows: [
      sdlcTicket, pollSkald, buildPhase, reviewPhase, sandboxRun,
      skaldRead, skaldSet, skaldLog, skaldListBuilding,
      heimrPrepareBuild, heimrPrepareReview, heimrHandoff, gitReconcile,
      gardrStart, gardrObserve, gardrCleanup,
    ],
    // Durable waits are evicted, so this bounds concurrent shell-outs, not tickets in flight.
    slots: 20,
  });
  await worker.start();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
