import { hatchet } from '../client.js';
import { run, runJson } from '../exec.js';

type GardrRunState = {
  id: string;
  state: string; // "running" | "exited" | "failed" | "stopped" | …
  exit_status: number | null;
  failure: string | null;
  usage?: unknown;
};

export const gardrStart = hatchet.task({
  name: 'gardr-start',
  fn: async (input: { workspacePath: string; spec: string; kind: 'build' | 'review' }): Promise<{ runId: string }> => {
    await runJson('gardr', ['run', 'validate-workspace', input.workspacePath]);
    const preamble = (await run('heimr', ['preamble', input.kind])).stdout.trim();
    const state = await runJson<GardrRunState>('gardr', [
      'run', 'start',
      '--workspace', input.workspacePath,
      '--spec', input.spec,
      '--harness-arg', preamble,
    ]);
    return { runId: state.id };
  },
});

export const gardrObserve = hatchet.task({
  name: 'gardr-observe',
  retries: 3,
  fn: async (input: { runId: string }): Promise<{ running: boolean; exitStatus: number | null; failure: string | null; state: string }> => {
    const s = await runJson<GardrRunState>('gardr', ['run', 'observe', input.runId]);
    return { running: s.state === 'running', exitStatus: s.exit_status, failure: s.failure, state: s.state };
  },
});

export const gardrCleanup = hatchet.task({
  name: 'gardr-cleanup',
  retries: 2,
  fn: async (input: { runId: string }) => {
    await runJson('gardr', ['run', 'cleanup', input.runId]);
    return { ok: true };
  },
});
