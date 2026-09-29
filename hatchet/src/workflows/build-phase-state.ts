import type { BuildHandoff, GitState } from '../tasks/heimr.js';

export type BuildAttemptDisposition = 'complete' | 'continue' | 'no-progress' | 'max-continuations';

export function normalizeBuildProblems(problems: string[]): string[] {
  return [...new Set(problems.map((problem) => problem.trim().replace(/\s+/g, ' ')).filter(Boolean))].sort();
}

export function buildAttemptDisposition(
  problems: string[],
  previousProblems: string[] | null,
  attempt: number,
  maxContinuations: number,
): BuildAttemptDisposition {
  if (problems.length === 0) return 'complete';

  const normalized = normalizeBuildProblems(problems);
  if (
    previousProblems !== null &&
    normalized.length === previousProblems.length &&
    normalized.every((problem, index) => problem === previousProblems[index])
  ) {
    return 'no-progress';
  }

  return attempt >= maxContinuations ? 'max-continuations' : 'continue';
}

export function buildTicketPointers(
  git: Pick<GitState, 'branch' | 'onTrunk'>,
  handoff: Pick<BuildHandoff, 'pr'> | null,
): { branch?: string; pr?: string } {
  return {
    ...(git.onTrunk ? {} : { branch: git.branch }),
    ...(handoff?.pr ? { pr: handoff.pr } : {}),
  };
}
