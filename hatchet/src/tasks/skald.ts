import { NonRetryableError } from '@hatchet-dev/typescript-sdk';
import { hatchet } from '../client.js';
import { run, runJson } from '../exec.js';

export type TicketStatus = 'refining' | 'designing' | 'building' | 'reviewing' | 'done' | 'cancelled';

export type Ticket = {
  id: string;
  title: string;
  status: TicketStatus;
  paused: string | null;
  repo: string;
  branch: string | null;
  pr: string | null;
  link: string | null;
  parent: string | null;
  acceptanceCriteria: string;
};

type SkaldListRow = {
  id: string;
  frontmatter: {
    title: string;
    status: TicketStatus;
    paused: string | null;
    repos: string[];
    branch: string | null;
    link: string | null;
    pr: string | null;
    parent: string | null;
  };
};

export const skaldRead = hatchet.task({
  name: 'skald-read',
  retries: 2,
  fn: async (input: { ticketId: string }): Promise<Ticket> => {
    const rows = await runJson<SkaldListRow[]>('skald', ['list', '--json']);
    const row = rows.find((r) => r.id === input.ticketId);
    if (!row) throw new NonRetryableError(`skald: no ticket ${input.ticketId}`);
    if (row.frontmatter.repos.length !== 1) {
      throw new NonRetryableError(
        `skald: ${input.ticketId} names ${row.frontmatter.repos.length} repos; a slice names exactly one`,
      );
    }
    const { stdout: acceptanceCriteria } = await run('skald', ['show', input.ticketId, '--section', 'ac']);
    const f = row.frontmatter;
    return {
      id: row.id,
      title: f.title,
      status: f.status,
      paused: f.paused,
      repo: f.repos[0],
      branch: f.branch,
      pr: f.pr,
      link: f.link,
      parent: f.parent,
      acceptanceCriteria: acceptanceCriteria.trim(),
    };
  },
});

export const skaldSet = hatchet.task({
  name: 'skald-set',
  retries: 2,
  fn: async (input: { ticketId: string; status?: TicketStatus; paused?: string; branch?: string; pr?: string }) => {
    const args = ['set', input.ticketId];
    if (input.status !== undefined) args.push('--status', input.status);
    if (input.paused !== undefined) args.push('--paused', input.paused);
    if (input.branch !== undefined) args.push('--branch', input.branch);
    if (input.pr !== undefined) args.push('--pr', input.pr);
    await run('skald', args);
    return { ok: true };
  },
});

export const skaldLog = hatchet.task({
  name: 'skald-log',
  retries: 2,
  fn: async (input: { ticketId: string; entry: string }) => {
    await run('skald', ['log', input.ticketId, '--stdin'], { stdin: input.entry.trim() + '\n' });
    return { ok: true };
  },
});

export const skaldListBuilding = hatchet.task({
  name: 'skald-list-building',
  fn: async (): Promise<{ ticketIds: string[] }> => {
    const rows = await runJson<SkaldListRow[]>('skald', ['list', '--json']);
    return {
      ticketIds: rows
        .filter((r) => ['building', 'reviewing'].includes(r.frontmatter.status) && !r.frontmatter.paused)
        .map((r) => r.id),
    };
  },
});
