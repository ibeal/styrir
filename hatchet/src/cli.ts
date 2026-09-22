import { hatchet } from './client.js';
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
