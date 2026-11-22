import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskMinutes, workerTotals } from '../src/shared/workerSummary';
import type { Task } from '../src/shared/types';

const task = (over: Partial<Task>): Task => ({
  id: 'T', title: 't', prompt: '', kind: 'code', repo: 'r', workerId: 'W-01', status: 'done', branch: null, prUrl: null, prState: null,
  summary: null, files: [], createdAt: '2026-11-22T00:00:00Z', updatedAt: '2026-11-22T00:00:00Z', finishedAt: null, reviewSyncedAt: null, seenCommentIds: [], ...over,
});
const spend = (costUsd: number, input: number) => ({ costUsd, input, output: 0, cacheRead: 0, cacheWrite: 0 });

test('tasks are counted by where they stand; cancelled ones are left out', () => {
  const tot = workerTotals([
    task({ status: 'done' }), task({ status: 'pr_open' }), task({ status: 'running' }), task({ status: 'queued' }),
    task({ status: 'waiting' }), task({ status: 'failed' }), task({ status: 'cancelled' }),
  ]);
  assert.deepEqual([tot.done, tot.open, tot.failed], [2, 3, 1]);
});

test('a PR counts once however many tasks worked on it, and merged wins', () => {
  const tot = workerTotals([
    task({ prUrl: 'https://x/pull/1', prState: 'OPEN' }), task({ prUrl: 'https://x/pull/1', prState: 'MERGED' }),
    task({ prUrl: 'https://x/pull/2', prState: 'OPEN' }), task({ prUrl: 'https://x/pull/3', prState: 'CLOSED' }),
  ]);
  assert.deepEqual([tot.prsOpen, tot.prsMerged], [1, 1]);
});

test('files are counted once and spend is summed', () => {
  const tot = workerTotals([task({ files: ['a.md', 'b.md'], spend: spend(0.5, 1000) }), task({ files: ['b.md'], spend: spend(0.25, 500) }), task({})]);
  assert.equal(tot.files, 2);
  assert.deepEqual(tot.spend, spend(0.75, 1500));
  assert.equal(workerTotals([]).spend, null);
});

test('a task took from its start to its finish, or to now while it runs', () => {
  const now = Date.parse('2026-11-22T01:00:00Z');
  assert.equal(taskMinutes({ startedAt: '2026-11-22T00:00:00Z', finishedAt: '2026-11-22T00:12:20Z', status: 'done' }, now), 12);
  assert.equal(taskMinutes({ startedAt: '2026-11-22T00:30:00Z', finishedAt: null, status: 'running' }, now), 30);
  assert.equal(taskMinutes({ startedAt: null, finishedAt: null, status: 'queued' }, now), null);
  assert.equal(taskMinutes({ startedAt: '2026-11-22T00:30:00Z', finishedAt: null, status: 'cancelled' }, now), null);
});
