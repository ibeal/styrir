import { existsSync, readFileSync } from 'node:fs';
import { hatchet } from '../client.js';
import { logged, run, runJson } from '../exec.js';

type GardrRunState = {
  id: string;
  state: string; // "running" | "exited" | "failed" | "stopped" | …
  exit_status: number | null;
  failure: string | null;
  usage?: unknown;
  stderr_path?: string;
};

function tail(path: string | undefined, bytes = 1500): string {
  if (!path || !existsSync(path)) return '';
  const text = readFileSync(path, 'utf8');
  return text.slice(-bytes).trim();
}

export const gardrStart = hatchet.task({
  name: 'gardr-start',
  fn: logged(async (input: { workspacePath: string; spec: string; kind: 'build' | 'review' }): Promise<{ runId: string }> => {
    await runJson('gardr', ['run', 'validate-workspace', input.workspacePath]);
    const preamble = (await run('heimr', ['preamble', input.kind])).stdout.trim();
    const state = await runJson<GardrRunState>('gardr', [
      'run', 'start',
      '--workspace', input.workspacePath,
      '--spec', input.spec,
      '--harness-arg', preamble,
    ]);
    return { runId: state.id };
  }),
});

export const gardrObserve = hatchet.task({
  name: 'gardr-observe',
  retries: 3,
  fn: logged(async (input: { runId: string }): Promise<{ running: boolean; exitStatus: number | null; failure: string | null; state: string }> => {
    const s = await runJson<GardrRunState>('gardr', ['run', 'observe', input.runId]);
    return { running: s.state === 'running', exitStatus: s.exit_status, failure: s.failure, state: s.state };
  }),
});

export const gardrCleanup = hatchet.task({
  name: 'gardr-cleanup',
  retries: 2,
  fn: logged(async (input: { runId: string }): Promise<{ stderrTail: string }> => {
    // cleanup captures the container's stderr; that is where a harness that died before
    // touching HANDOFF.json (bad model id, auth, image contract) says why.
    const state = await runJson<GardrRunState>('gardr', ['run', 'cleanup', input.runId]);
    return { stderrTail: tail(state.stderr_path) };
  }),
});
