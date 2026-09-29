import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildAttemptDisposition, buildTicketPointers, normalizeBuildProblems } from './build-phase-state.js';

test('identical normalized problems stop after one continuation', () => {
  const firstAttempt = normalizeBuildProblems([' blocker: needs human ', 'worktree   dirty']);

  assert.equal(
    buildAttemptDisposition(['worktree dirty', 'blocker: needs human'], firstAttempt, 1, 3),
    'no-progress',
  );
});

test('differing problems continue until the continuation cap', () => {
  const firstAttempt = normalizeBuildProblems(['no PR in handoff']);

  assert.equal(buildAttemptDisposition(['branch not pushed'], firstAttempt, 1, 2), 'continue');
  assert.equal(buildAttemptDisposition(['worktree dirty'], normalizeBuildProblems(['branch not pushed']), 2, 2), 'max-continuations');
});

test('non-success ticket updates preserve available branch and PR', () => {
  assert.deepEqual(
    buildTicketPointers(
      { branch: 'ask-2026-09-29-styrir-build-escalation', onTrunk: false },
      { pr: 'https://example.test/pull/731' },
    ),
    {
      branch: 'ask-2026-09-29-styrir-build-escalation',
      pr: 'https://example.test/pull/731',
    },
  );
});
