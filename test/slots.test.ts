import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_WORKERS_DEFAULT, canStart, clampMaxWorkers, holdsSlot, queueOrder, slotsUsed, waitsForLimit, waitsForSlot } from '../src/shared/slots';
import type { Task } from '../src/shared/types';

function task(id: string, patch: Partial<Task> = {}): Task {
  return {
    id, title: id, prompt: '', kind: 'other', repo: null, workerId: 'W-1', status: 'running',
    branch: null, prUrl: null, prState: null, summary: null, files: [],
    createdAt: '', updatedAt: '2026-11-21T00:00:00Z', finishedAt: null, reviewSyncedAt: null, seenCommentIds: [],
    ...patch,
  };
}

test('slots: the limit is a whole number from 1 to 8, 3 when unreadable', () => {
  assert.equal(MAX_WORKERS_DEFAULT, 3);
  assert.equal(clampMaxWorkers(0), 1);
  assert.equal(clampMaxWorkers(12), 8);
  assert.equal(clampMaxWorkers('5'), 5);
  assert.equal(clampMaxWorkers(2.6), 3);
  assert.equal(clampMaxWorkers('x'), 3);
  assert.equal(clampMaxWorkers(undefined), 3);
});

test('slots: running and waiting-for-you tasks hold a slot, nothing else does', () => {
  assert.equal(holdsSlot(task('T-1', { status: 'running' })), true);
  assert.equal(holdsSlot(task('T-1', { status: 'waiting' })), true);
  for (const status of ['queued', 'blocked', 'pr_open', 'done', 'failed', 'cancelled'] as const) {
    assert.equal(holdsSlot(task('T-1', { status })), false, status);
  }
});

test('slots: a Worker counts once, however many of its tasks are open', () => {
  const tasks = [
    task('T-1', { workerId: 'W-1' }),
    task('T-2', { workerId: 'W-1', status: 'waiting' }),
    task('T-3', { workerId: 'W-2', status: 'waiting' }),
    task('T-4', { workerId: 'W-3', status: 'queued', queueReason: 'slot' }),
    task('T-5', { workerId: 'W-4', status: 'pr_open' }),
  ];
  assert.equal(slotsUsed(tasks), 2);
});

test('slots: a Worker holding a slot may start more; others need a free one', () => {
  const tasks = [task('T-1', { workerId: 'W-1' }), task('T-2', { workerId: 'W-2' })];
  assert.equal(canStart(tasks, 'W-3', 3), true);
  assert.equal(canStart(tasks, 'W-3', 2), false);
  assert.equal(canStart(tasks, 'W-1', 2), true);
  // A lower limit stops nothing; it only keeps new work out.
  assert.equal(canStart(tasks, 'W-2', 1), true);
  assert.equal(canStart(tasks, 'W-3', 1), false);
});

test('slots: a queued task waits for a slot or for a limit; older state without a reason waited for a limit', () => {
  assert.equal(waitsForSlot(task('T-1', { status: 'queued', queueReason: 'slot' })), true);
  assert.equal(waitsForLimit(task('T-1', { status: 'queued', queueReason: 'slot' })), false);
  assert.equal(waitsForLimit(task('T-1', { status: 'queued', queueReason: 'limit' })), true);
  assert.equal(waitsForLimit(task('T-1', { status: 'queued' })), true);
  // The reason means nothing once the task left the queue.
  assert.equal(waitsForSlot(task('T-1', { status: 'running', queueReason: 'slot' })), false);
  assert.equal(waitsForLimit(task('T-1', { status: 'blocked' })), false);
});

test('slots: the longest waiting goes first, each kind on its own', () => {
  const tasks = [
    task('T-1', { status: 'queued', queueReason: 'slot', updatedAt: '2026-11-21T03:00:00Z' }),
    task('T-2', { status: 'queued', queueReason: 'limit', updatedAt: '2026-11-21T01:00:00Z' }),
    task('T-3', { status: 'queued', queueReason: 'slot', updatedAt: '2026-11-21T02:00:00Z' }),
    task('T-4', { status: 'running', queueReason: 'slot', updatedAt: '2026-11-21T00:00:00Z' }),
    task('T-5', { status: 'queued', updatedAt: '2026-11-21T00:30:00Z' }),
  ];
  assert.deepEqual(queueOrder(tasks, 'slot').map((x) => x.id), ['T-3', 'T-1']);
  assert.deepEqual(queueOrder(tasks, 'limit').map((x) => x.id), ['T-5', 'T-2']);
});
