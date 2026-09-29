import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideBuildStep, sameProblems, survivingWork } from './build-phase-logic.js';
import type { GitState, BuildHandoff } from '../tasks/heimr.js';

function git(overrides: Partial<GitState> = {}): GitState {
  return { branch: 'feature', dirty: false, ahead: 1, pushed: true, onTrunk: false, ...overrides };
}

test('sameProblems ignores order', () => {
  assert.equal(sameProblems(['a', 'b'], ['b', 'a']), true);
  assert.equal(sameProblems(['a', 'b'], ['a', 'c']), false);
  assert.equal(sameProblems(['a'], ['a', 'b']), false);
});

test('a continuation with identical problems escalates to refining after one continuation', () => {
  const first = decideBuildStep({
    humanResumed: false,
    handoffStatus: 'partial',
    escalationReason: 'no reason given',
    problems: ['handoff status partial', 'no PR in handoff'],
    previousProblems: null,
    attempt: 0,
    maxContinuations: 5,
  });
  assert.deepEqual(first, { action: 'continue' });

  const second = decideBuildStep({
    humanResumed: false,
    handoffStatus: 'partial',
    escalationReason: 'no reason given',
    problems: ['no PR in handoff', 'handoff status partial'], // same set, different order
    previousProblems: ['handoff status partial', 'no PR in handoff'],
    attempt: 1,
    maxContinuations: 5,
  });
  assert.equal(second.action, 'escalate-no-progress');
});

test('differing problems keep continuing up to the cap', () => {
  const attempt1 = decideBuildStep({
    humanResumed: false,
    handoffStatus: 'partial',
    escalationReason: 'no reason given',
    problems: ['worktree dirty'],
    previousProblems: null,
    attempt: 0,
    maxContinuations: 2,
  });
  assert.deepEqual(attempt1, { action: 'continue' });

  const attempt2 = decideBuildStep({
    humanResumed: false,
    handoffStatus: 'partial',
    escalationReason: 'no reason given',
    problems: ['branch not pushed'], // different from attempt 1 — real progress, not a repeat
    previousProblems: ['worktree dirty'],
    attempt: 1,
    maxContinuations: 2,
  });
  assert.deepEqual(attempt2, { action: 'continue' });

  const attempt3 = decideBuildStep({
    humanResumed: false,
    handoffStatus: 'partial',
    escalationReason: 'no reason given',
    problems: ['still incomplete'],
    previousProblems: ['branch not pushed'],
    attempt: 2,
    maxContinuations: 2,
  });
  assert.equal(attempt3.action, 'max-continuations');
});

test('a worker escalation wins over a same-problems comparison', () => {
  const decision = decideBuildStep({
    humanResumed: false,
    handoffStatus: 'escalated',
    escalationReason: 'sandbox has no network egress',
    problems: ['handoff status escalated'],
    previousProblems: ['handoff status escalated'],
    attempt: 1,
    maxContinuations: 5,
  });
  assert.deepEqual(decision, { action: 'escalate-worker', reason: 'sandbox has no network egress' });
});

test('a human-resumed attempt always continues, never escalates on no-progress', () => {
  const decision = decideBuildStep({
    humanResumed: true,
    handoffStatus: 'partial',
    escalationReason: 'no reason given',
    problems: ['worktree dirty'],
    previousProblems: ['worktree dirty'],
    attempt: 3,
    maxContinuations: 2,
  });
  assert.deepEqual(decision, { action: 'continue' });
});

test('success requires zero problems', () => {
  const decision = decideBuildStep({
    humanResumed: false,
    handoffStatus: 'complete',
    escalationReason: 'no reason given',
    problems: [],
    previousProblems: ['handoff status partial'],
    attempt: 1,
    maxContinuations: 5,
  });
  assert.deepEqual(decision, { action: 'success' });
});

test('survivingWork persists branch when off trunk and pr when the handoff has one', () => {
  const handoff: BuildHandoff = { version: 1, status: 'partial', pr: 'https://example.com/pr/1' };
  assert.deepEqual(survivingWork(git({ branch: 'feature', onTrunk: false }), handoff), {
    branch: 'feature',
    pr: 'https://example.com/pr/1',
  });
});

test('survivingWork omits branch on trunk and pr when the handoff has none', () => {
  assert.deepEqual(survivingWork(git({ onTrunk: true }), null), {});
});

test('survivingWork on the pause path: branch persists even without a PR yet', () => {
  const handoff: BuildHandoff = { version: 1, status: 'partial' };
  assert.deepEqual(survivingWork(git({ branch: 'wip', onTrunk: false }), handoff), { branch: 'wip' });
});
