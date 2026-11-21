import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cancelSet, describeCancel, followersOf, hasOpenPr, isQueued, statusAfterCancel } from '../src/shared/queue';
import type { Task } from '../src/shared/types';

function task(id: string, patch: Partial<Task> = {}): Task {
  return {
    id, title: `title ${id}`, prompt: '', kind: 'code', repo: 'demo', workerId: 'W-01', status: 'queued',
    branch: `agent/${id.toLowerCase()}`, prUrl: null, prState: null, summary: null, files: [],
    createdAt: '', updatedAt: '', finishedAt: null, reviewSyncedAt: null, seenCommentIds: [], afterTaskId: null,
    ...patch,
  };
}

test('queue: only queued and blocked tasks count as waiting', () => {
  assert.equal(isQueued(task('T-1', { status: 'queued' })), true);
  assert.equal(isQueued(task('T-1', { status: 'blocked' })), true);
  for (const status of ['running', 'waiting', 'pr_open', 'done', 'failed', 'cancelled'] as const) {
    assert.equal(isQueued(task('T-1', { status })), false, status);
  }
});

test('queue: a task that never finished is cancelled', () => {
  assert.equal(statusAfterCancel(task('T-1')), 'cancelled');
  assert.equal(statusAfterCancel(task('T-1', { status: 'blocked' })), 'cancelled');
});

test('queue: queued review or CI work on an open PR goes back to the PR, which stays open', () => {
  const t = task('T-1', { prUrl: 'https://github.com/o/r/pull/7', prState: 'OPEN', finishedAt: '2026-11-20T00:00:00Z' });
  assert.equal(hasOpenPr(t), true);
  assert.equal(statusAfterCancel(t), 'pr_open');
});

test('queue: a queued follow-up on a finished task without a PR keeps the task done', () => {
  assert.equal(statusAfterCancel(task('T-1', { finishedAt: '2026-11-20T00:00:00Z' })), 'done');
  assert.equal(statusAfterCancel(task('T-1', { finishedAt: '2026-11-20T00:00:00Z', prUrl: 'https://github.com/o/r/pull/7', prState: 'MERGED' })), 'done');
});

test('queue: followers are found through chains of waiting tasks, once each', () => {
  const tasks = [
    task('T-1'),
    task('T-2', { status: 'blocked', afterTaskId: 'T-1' }),
    task('T-3', { status: 'blocked', afterTaskId: 'T-2' }),
    task('T-4', { status: 'blocked', afterTaskId: 'T-1' }),
    task('T-5', { status: 'blocked', afterTaskId: 'T-9' }),
    // Already started after its dependency merged: not a follower any more.
    task('T-6', { status: 'running', afterTaskId: 'T-1' }),
  ];
  assert.deepEqual(followersOf(tasks, 'T-1').map((x) => x.id), ['T-2', 'T-3', 'T-4']);
  assert.deepEqual(followersOf(tasks, 'T-2').map((x) => x.id), ['T-3']);
  assert.deepEqual(followersOf(tasks, 'T-5').map((x) => x.id), []);
});

test('queue: cancelSet skips tasks that are not waiting and does not list a picked task as a follower', () => {
  const tasks = [
    task('T-1'),
    task('T-2', { status: 'blocked', afterTaskId: 'T-1' }),
    task('T-3', { status: 'running' }),
  ];
  const one = cancelSet(tasks, ['T-1', 'T-3', 'T-404']);
  assert.deepEqual(one.picked.map((x) => x.id), ['T-1']);
  assert.deepEqual(one.followers.map((x) => x.id), ['T-2']);
  const both = cancelSet(tasks, ['T-1', 'T-2']);
  assert.deepEqual(both.picked.map((x) => x.id), ['T-1', 'T-2']);
  assert.deepEqual(both.followers, []);
});

test('queue: followers keep waiting when the task keeps an open PR', () => {
  const tasks = [
    task('T-1', { prUrl: 'https://github.com/o/r/pull/7', prState: 'OPEN', finishedAt: '2026-11-20T00:00:00Z' }),
    task('T-2', { status: 'blocked', afterTaskId: 'T-1' }),
  ];
  const s = cancelSet(tasks, ['T-1']);
  assert.deepEqual(s.picked.map((x) => x.id), ['T-1']);
  assert.deepEqual(s.followers, []);
});

test('queue: the Dispatcher reads what happened to each task', () => {
  assert.equal(describeCancel({ id: 'T-1', title: 'A', workerId: 'W-01', status: 'cancelled', followerOf: null, kept: null }), 'T-1 "A" cancelled');
  assert.equal(describeCancel({ id: 'T-2', title: 'B', workerId: 'W-01', status: 'cancelled', followerOf: 'T-1', kept: null }), 'T-2 "B" cancelled (it waited for T-1)');
  assert.equal(describeCancel({ id: 'T-3', title: 'C', workerId: 'W-01', status: 'pr_open', followerOf: null, kept: null }), 'T-3 "C" queued work dropped; the task stays pr_open and its PR stays open');
  assert.equal(
    describeCancel({ id: 'T-4', title: 'D', workerId: 'W-01', status: 'cancelled', followerOf: null, kept: { branch: 'agent/t-4', commits: 2, dirty: true, path: '/wt/W-01' } }),
    'T-4 "D" cancelled; branch agent/t-4 kept in /wt/W-01 (2 commit(s), uncommitted changes)',
  );
});
