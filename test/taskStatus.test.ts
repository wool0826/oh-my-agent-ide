import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canReopen, REOPEN_MS, setStatus } from '../src/shared/taskStatus';
import type { Task } from '../src/shared/types';

const NOW = Date.parse('2026-11-26T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function task(patch: Partial<Task> = {}): Task {
  return {
    id: 'T-1', title: 'Task', prompt: '', kind: 'code', repo: 'demo', workerId: 'W-01', status: 'running',
    branch: 'agent/t-1', prUrl: null, prState: null, summary: null, files: [],
    createdAt: '', updatedAt: '', finishedAt: null, reviewSyncedAt: null, seenCommentIds: [], afterTaskId: null,
    ...patch,
  };
}

test('taskStatus: starting a wait starts its timer and names what it waits on', () => {
  const x = task({ slotReleased: true });
  setStatus(x, 'waiting', 'dispatcher', '2026-11-26T12:00:00.000Z');
  assert.equal(x.status, 'waiting');
  assert.equal(x.waitingOn, 'dispatcher');
  assert.equal(x.waitingSince, '2026-11-26T12:00:00.000Z');
  assert.equal(x.slotReleased, false);
});

test('taskStatus: ending a wait forgets its timer and released slot', () => {
  const x = task({ status: 'waiting', waitingOn: 'dispatcher', waitingSince: ago(60_000), slotReleased: true });
  setStatus(x, 'running');
  assert.equal(x.waitingSince, null);
  assert.equal(x.slotReleased, false);
  assert.equal(x.waitingOn, null);
});

test('taskStatus: a wait that goes on keeps its timer', () => {
  const since = ago(60_000);
  const x = task({ status: 'waiting', waitingSince: since, slotReleased: true });
  setStatus(x, 'waiting', null, '2026-11-26T13:00:00.000Z');
  assert.equal(x.waitingSince, since);
  assert.equal(x.slotReleased, true);
});

test('taskStatus: a follow-up reopens a task done, in review or failed within 3 days', () => {
  assert.equal(canReopen(task({ status: 'done', finishedAt: ago(1000) }), NOW), true);
  assert.equal(canReopen(task({ status: 'pr_open', prState: 'OPEN', finishedAt: ago(REOPEN_MS - 1000) }), NOW), true);
  assert.equal(canReopen(task({ status: 'failed', updatedAt: ago(1000) }), NOW), true);
});

test('taskStatus: an older task, one still open, or one whose PR was merged or closed is not reopened', () => {
  assert.equal(canReopen(null, NOW), false);
  assert.equal(canReopen(task({ status: 'done', finishedAt: ago(REOPEN_MS + 1000) }), NOW), false);
  assert.equal(canReopen(task({ status: 'done', finishedAt: null }), NOW), false);
  assert.equal(canReopen(task({ status: 'cancelled', finishedAt: ago(1000) }), NOW), false);
  assert.equal(canReopen(task({ status: 'pr_open', prState: 'MERGED', finishedAt: ago(1000) }), NOW), false);
  assert.equal(canReopen(task({ status: 'pr_open', prState: 'CLOSED', finishedAt: ago(1000) }), NOW), false);
});
