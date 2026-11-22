import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canMerge, conflictBody, mergeMethod, planConflictFix, readyToMerge } from '../src/shared/prMerge';
import type { PrChecks } from '../src/shared/types';

const ok: PrChecks = { ci: 'passing', failed: [], conflicts: false, review: null };

test('a conflict is handed over once per pair of head and base commits', () => {
  const task: { conflictSeen?: string } = {};
  assert.equal(planConflictFix(task, true, 'aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'), true);
  assert.equal(planConflictFix(task, true, 'aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'), false);
  // The base moved again, or the Worker pushed and it still conflicts: a new conflict.
  assert.equal(planConflictFix(task, true, 'aaaaaaaaaaaaaaaa', 'cccccccccccccccc'), true);
  assert.equal(planConflictFix(task, true, 'dddddddddddddddd', 'cccccccccccccccc'), true);
});

test('nothing is handed over without a conflict or without both commits', () => {
  const task: { conflictSeen?: string } = {};
  assert.equal(planConflictFix(task, false, 'a', 'b'), false);
  assert.equal(planConflictFix(task, true, '', 'b'), false);
  assert.equal(planConflictFix(task, true, 'a', ''), false);
  assert.equal(task.conflictSeen, undefined);
});

test('the Worker is told to merge the base in, not to rebase', () => {
  const body = conflictBody('main');
  assert.match(body, /merge `origin\/main`/);
  assert.match(body, /Do not rebase and do not force-push/);
});

test('a PR can be merged when nothing is failing, running, conflicting or waiting for review', () => {
  assert.equal(canMerge(ok), true);
  assert.equal(canMerge({ ...ok, ci: 'none' }), true);
  assert.equal(canMerge({ ...ok, review: 'approved' }), true);
  assert.equal(canMerge({ ...ok, ci: 'pending' }), false);
  assert.equal(canMerge({ ...ok, ci: 'failing', failed: ['test'] }), false);
  assert.equal(canMerge({ ...ok, conflicts: true }), false);
  assert.equal(canMerge({ ...ok, review: 'required' }), false);
  assert.equal(canMerge({ ...ok, review: 'changes' }), false);
  assert.equal(canMerge(null), false);
});

test('the merge method is one the repository allows, squash first', () => {
  assert.equal(mergeMethod({ squashMergeAllowed: true, mergeCommitAllowed: true, rebaseMergeAllowed: true }), 'squash');
  assert.equal(mergeMethod({ squashMergeAllowed: false, mergeCommitAllowed: true, rebaseMergeAllowed: true }), 'merge');
  assert.equal(mergeMethod({ squashMergeAllowed: false, mergeCommitAllowed: false, rebaseMergeAllowed: true }), 'rebase');
  assert.equal(mergeMethod(null), 'squash');
});

test('"Merge N" takes each ready open PR once and leaves out one still being worked on', () => {
  const ok = { ci: 'passing' as const, failed: [], conflicts: false, review: 'approved' as const };
  const pr = (id: string, n: number, status: string, prState: string | null, prChecks: typeof ok | null) => ({ id, prUrl: `https://github.com/o/r/pull/${n}`, prState, status, prChecks });
  const tasks = [
    pr('T-1', 1, 'pr_open', 'OPEN', ok), pr('T-2', 1, 'done', 'OPEN', ok),
    pr('T-3', 2, 'pr_open', 'OPEN', { ...ok, conflicts: true }), pr('T-4', 3, 'done', 'MERGED', ok),
    pr('T-5', 4, 'pr_open', 'OPEN', ok), pr('T-6', 4, 'running', 'OPEN', ok), pr('T-7', 5, 'pr_open', 'OPEN', ok),
    { id: 'T-8', prUrl: null, prState: null, status: 'done', prChecks: null },
  ];
  assert.deepEqual(readyToMerge(tasks).map((x) => x.id), ['T-1', 'T-7']);
});
