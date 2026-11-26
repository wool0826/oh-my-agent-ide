import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callers, canReopen, moveLine, REOPEN_MS, setStatus, statusMoves } from '../src/shared/taskStatus';
import type { TaskStatus } from '../src/shared/types';
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

test('taskStatus: statusMoves lists each status change once, with whether the task has a PR', () => {
  const seen = new Map<string, TaskStatus>();
  const a = task({ id: 'T-1', status: 'running' });
  const b = task({ id: 'T-2', status: 'blocked' });
  assert.deepEqual(statusMoves(seen, [a, b]), [], 'first sight is not a move');
  a.status = 'done';
  b.status = 'running';
  b.prUrl = 'https://github.com/o/r/pull/1';
  assert.deepEqual(statusMoves(seen, [a, b]), [{ id: 'T-1', from: 'running', to: 'done', pr: false }, { id: 'T-2', from: 'blocked', to: 'running', pr: true }]);
  assert.deepEqual(statusMoves(seen, [a, b]), []);
  statusMoves(seen, [b]);
  assert.deepEqual([...seen.keys()], ['T-2'], 'a task gone from the list is forgotten');
  assert.equal(moveLine({ id: 'T-1', from: 'running', to: 'done', pr: false }, 'finish < onResult'), 'task T-1 running -> done (PR: no) via finish < onResult');
});

test('taskStatus: callers names the functions below one on a stack, nearest first, without anonymous frames', () => {
  const stack = [
    'Error',
    '    at Store.logMoves (C:/app/dist/main.js:10:5)',
    '    at Store.changed (C:/app/dist/main.js:20:5)',
    '    at C:/app/dist/main.js:30:5',
    '    at Store.chat (C:/app/dist/main.js:35:5)',
    '    at fail (C:/app/dist/main.js:40:5)',
    '    at async WorkerManager.onResult (C:/app/dist/main.js:50:5)',
    '    at Array.forEach (<anonymous>)',
    '    at retryQueued (C:/app/dist/main.js:60:5)',
    '    at more (C:/app/dist/main.js:70:5)',
  ].join('\n');
  assert.equal(callers(stack, 'logMoves'), 'fail < WorkerManager.onResult < retryQueued');
  assert.equal(callers('Error', 'logMoves'), 'unknown');
});
