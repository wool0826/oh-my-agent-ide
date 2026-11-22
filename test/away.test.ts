import { test } from 'node:test';
import assert from 'node:assert/strict';
import { awayDigest, awayRows } from '../src/shared/away';
import type { Task } from '../src/shared/types';

const at = (min: number) => new Date(Date.parse('2026-11-22T10:00:00Z') + min * 60_000).toISOString();
const task = (id: string, status: Task['status'], finishedMin: number | null, extra: Partial<Task> = {}): Task => ({
  id, title: id, prompt: '', kind: 'code', repo: 'r', workerId: 'W', status, branch: null, prUrl: null, prState: null, summary: null, files: [],
  createdAt: at(-100), updatedAt: at(finishedMin ?? 0), finishedAt: finishedMin === null ? null : at(finishedMin), reviewSyncedAt: null, seenCommentIds: [], ...extra,
});
const now = Date.parse(at(60));

test('a short absence, or one in which nothing happened, has no digest', () => {
  const tasks = [task('T-1', 'done', 30)];
  assert.equal(awayDigest({ tasks, decisions: [] }, at(57), now), null);
  assert.equal(awayDigest({ tasks: [task('T-0', 'done', -30)], decisions: [] }, at(0), now), null);
  assert.equal(awayDigest({ tasks, decisions: [] }, null, now), null);
});

test('the digest sorts what ended since the user last looked', () => {
  const tasks = [
    task('T-1', 'done', 10), task('T-2', 'pr_open', 20), task('T-3', 'failed', 30), task('T-4', 'failed', 40, { stopped: true }),
    task('T-5', 'done', -20, { mergedAt: at(50) }), task('T-6', 'running', null), task('T-7', 'done', -5),
  ];
  const d = awayDigest({ tasks, decisions: [{ status: 'pending', createdAt: at(15) }, { status: 'pending', createdAt: at(-15) }, { status: 'answered', createdAt: at(20) }] }, at(0), now)!;
  assert.equal(d.minutes, 60);
  assert.deepEqual(d.finished.map((x) => x.id), ['T-2', 'T-1']);
  assert.deepEqual(d.failed.map((x) => x.id), ['T-3']);
  assert.deepEqual(d.merged.map((x) => x.id), ['T-5']);
  assert.equal(d.waiting, 1);
  assert.deepEqual(awayRows(d).map((r) => `${r.kind}:${r.task.id}`), ['failed:T-3', 'merged:T-5', 'finished:T-2', 'finished:T-1']);
  assert.equal(awayRows(d, 2).length, 2);
});

test('a decision alone is worth a digest', () => {
  assert.equal(awayDigest({ tasks: [], decisions: [{ status: 'pending', createdAt: at(30) }] }, at(0), now)?.waiting, 1);
});
