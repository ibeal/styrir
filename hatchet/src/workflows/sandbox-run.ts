import type { JsonObject } from '@hatchet-dev/typescript-sdk';
import { ConcurrencyLimitStrategy } from '@hatchet-dev/typescript-sdk';
import type { DurableContext } from '@hatchet-dev/typescript-sdk';
import { hatchet } from '../client.js';
import { config, resolveModel, statusForKind } from '../config.js';
import { gardrCleanup, gardrObserve, gardrStart } from '../tasks/gardr.js';
import { heimrHandoff } from '../tasks/heimr.js';
import { skaldLog } from '../tasks/skald.js';

export type SandboxRunInput = {
  workspace: string;
  workspacePath: string;
  dispatch: string;
  spec: string;
  kind: 'build' | 'review';
  ticketId: string;
  repo: string;
  complexity: number | null;
  provider: string | null;
};

export type SandboxRunOutput = {
  runId: string;
  exitStatus: number | null;
  failure: string | null;
  handoff: JsonObject | null;
  stderrTail: string;
};

// One Gardr container, start to handoff. Durable so the wait costs no worker slot; the
// tenant-scoped concurrency group is what bounds how many sandboxes run on the laptop.
export const sandboxRun = hatchet.durableTask({
  name: 'sandbox-run',
  executionTimeout: '6h',
  concurrency: {
    name: 'gardr-sandboxes',
    isTenantScoped: true,
    expression: '"laptop"',
    maxRuns: config.maxConcurrentSandboxes,
    limitStrategy: ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN,
  },
  fn: async (input: SandboxRunInput, ctx: DurableContext<SandboxRunInput>): Promise<SandboxRunOutput> => {
    // A missing tier, unknown provider, or a status with no default fails the run outright —
    // never silently falls back to whatever model the gardr spec pins.
    const { tier, provider, model } = resolveModel({
      repoSlug: input.repo,
      status: statusForKind(input.kind),
      complexity: input.complexity,
      provider: input.provider,
    });
    await skaldLog.run({
      ticketId: input.ticketId,
      entry: `sandbox ${input.kind}: tier ${tier}, provider ${provider}, model ${model}`,
    });

    const { runId } = await gardrStart.run({
      workspacePath: input.workspacePath,
      spec: input.spec,
      kind: input.kind,
      model,
    });

    let observed = await gardrObserve.run({ runId });
    while (observed.running) {
      await ctx.sleepFor({ seconds: config.pollIntervalSeconds });
      observed = await gardrObserve.run({ runId });
    }

    const { stderrTail } = await gardrCleanup.run({ runId });
    const { handoff } = await heimrHandoff.run({ workspace: input.workspace, dispatch: input.dispatch });
    return { runId, exitStatus: observed.exitStatus, failure: observed.failure, handoff, stderrTail };
  },
});
