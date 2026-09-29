// Pure decision logic for `build-phase`, split out so it is unit-testable without pulling in the
// hatchet client (a live token/connection) that `build-phase.ts` needs for its task wrappers.
import type { BuildHandoff, GitState } from '../tasks/heimr.js';

// Order-independent comparison of two `buildProblems` results. Does not change what counts as a
// problem — only whether two problem sets, possibly listed in a different order, are the same one.
export function sameProblems(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((p, i) => p === sb[i]);
}

// What every non-success exit persists to the skald ticket: the branch (unless the worktree never
// left trunk) and the PR (if the handoff ever recorded one), so a paused/escalated ticket doesn't
// lose track of surviving work the way it used to when only the success and escalation paths wrote
// these fields.
export function survivingWork(git: GitState, handoff: BuildHandoff | null): { branch?: string; pr?: string } {
  const out: { branch?: string; pr?: string } = {};
  if (!git.onTrunk) out.branch = git.branch;
  if (handoff?.pr) out.pr = handoff.pr;
  return out;
}

export type BuildStepDecision =
  | { action: 'continue' }
  | { action: 'success' }
  | { action: 'escalate-worker'; reason: string }
  | { action: 'escalate-no-progress'; reason: string }
  | { action: 'max-continuations'; reason: string };

// Pure so the loop-ending rules — worker escalation, success, no-progress, and the continuation
// cap — are unit-testable without driving the sandbox or skald. `build-phase.ts` is the thin
// wrapper that performs the IO this decision implies.
export function decideBuildStep(input: {
  humanResumed: boolean;
  handoffStatus: string | null | undefined;
  escalationReason: string;
  problems: string[];
  previousProblems: string[] | null;
  attempt: number;
  maxContinuations: number;
}): BuildStepDecision {
  if (input.humanResumed) return { action: 'continue' };
  if (input.handoffStatus === 'escalated') return { action: 'escalate-worker', reason: input.escalationReason };
  if (input.problems.length === 0) return { action: 'success' };
  if (input.previousProblems !== null && sameProblems(input.problems, input.previousProblems)) {
    return { action: 'escalate-no-progress', reason: `no progress since previous attempt — ${input.problems.join('; ')}` };
  }
  if (input.attempt >= input.maxContinuations) return { action: 'max-continuations', reason: input.problems.join('; ') };
  return { action: 'continue' };
}
