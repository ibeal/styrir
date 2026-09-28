import { hatchet } from './client.js';
import { run } from './exec.js';
import { nextBuildDispatch, stageDispatchFile } from './tasks/heimr.js';
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
      // Stage the note durably, straight into the dispatch the next build round will seal, before
      // touching anything else: a run may or may not be alive to catch the event below, and this
      // is what a fresh respawn's next build round finds already sitting in its own inbox.
      const { workspace, workspacePath, dispatch } = await nextBuildDispatch(ticketId);
      await stageDispatchFile(workspace, workspacePath, dispatch, 'inbox/human-note.md', `${signal.note}\n`);
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
