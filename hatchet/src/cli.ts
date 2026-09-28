import { existsSync } from 'node:fs';
import { hatchet } from './client.js';
import { run } from './exec.js';
import { resolveWorkspacePath, writePendingRework } from './tasks/heimr.js';
import { sdlcTicket, TICKET_SIGNAL_EVENT, ticketSignalSchema } from './workflows/ticket.js';

const usage = `usage:
  styrir start  <ticket-id>                        start (or no-op if already running) the SDLC run for a ticket
  styrir signal <ticket-id> merged|rework|cancel [note]   answer a run parked at the human boundary`;

async function main(argv: string[]) {
  const [cmd, ticketId, ...rest] = argv;
  if (!cmd || !ticketId) throw new Error(usage);

  if (cmd === 'start') {
    const ref = await sdlcTicket.runNoWait({ ticketId });
    console.log(JSON.stringify({ ticketId, runId: await ref.getWorkflowRunId() }));
    return;
  }

  if (cmd === 'signal') {
    const [action, ...noteParts] = rest;
    const signal = ticketSignalSchema.parse({ ticketId, action, note: noteParts.length ? noteParts.join(' ') : undefined });

    if (signal.action === 'rework') {
      if (!signal.note) throw new Error('rework requires a note: styrir signal <ticket-id> rework "<note>"');
      // Record the note durably before touching anything else: a run may or may not be alive to
      // catch the event below, and this is what a fresh respawn's next build round reads instead.
      const workspacePath = await resolveWorkspacePath(`${ticketId}-build`);
      if (!existsSync(`${workspacePath}/WORK.md`)) throw new Error(`no build workspace for ${ticketId} yet; nothing to rework`);
      writePendingRework(workspacePath, signal.note);
      // A live run parked at `reviewing` catches this straight from waitForEvent; one that has
      // already exited (e.g. paused after the review-round cap) needs the ticket unparked and
      // back at `building` for the poll cron to pick it up and derive the rework round itself.
      await run('skald', ['set', ticketId, '--status', 'building', '--paused', '']);
    }

    await hatchet.events.push(TICKET_SIGNAL_EVENT, signal, { scope: `ticket:${ticketId}` });
    console.log(JSON.stringify(signal));
    return;
  }

  throw new Error(usage);
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
