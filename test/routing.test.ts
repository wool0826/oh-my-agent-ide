import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REUSE_MAX_CONTEXT, describePick, keywords, newWorkLine, pickWorker, rankWorkers, reuseBlock, type NewTask } from '../src/shared/routing';
import { WORKER_TASK_COMPACT } from '../src/shared/context';
import type { Task, Worker } from '../src/shared/types';

const NOW = Date.parse('2026-11-21T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();
const MODEL = 'claude-opus-5-5';

function worker(id: string, patch: Partial<Worker> = {}): Worker {
  return {
    id, title: id, model: MODEL, accountId: null, sessionId: 's', cwd: `/w/${id}`, repo: 'demo', status: 'idle', statusText: '',
    contextTokens: 40_000, taskIds: [], createdAt: '', lastActiveAt: hoursAgo(1), knowledge: '',
    ...patch,
  };
}

function task(id: string, patch: Partial<Task> = {}): Task {
  return {
    id, title: `title ${id}`, prompt: '', kind: 'code', repo: 'demo', workerId: 'W-01', status: 'done',
    branch: null, prUrl: null, prState: null, summary: null, files: [],
    createdAt: '', updatedAt: '', finishedAt: null, reviewSyncedAt: null, seenCommentIds: [], afterTaskId: null,
    ...patch,
  };
}

const nt = (patch: Partial<NewTask> = {}): NewTask => ({ title: 'PR monitor shows a merged PR twice', prompt: '', kind: 'code', repo: 'demo', ...patch });

test('routing: keywords drop filler, numbers and short ASCII words', () => {
  const k = keywords('Fix the PR monitor so 2 tasks on PR #17 show once in prmonitor.ts');
  assert.ok(k.has('monitor'));
  assert.ok(k.has('prmonitor'));
  for (const w of ['fix', 'the', 'pr', '17', 'so', 'tasks']) assert.ok(!k.has(w), w);
});

test('routing: a code task goes to an idle Worker on its repository, never one on another', () => {
  const ws = [worker('W-01', { repo: 'other' }), worker('W-02')];
  const tasks = [task('T-1', { workerId: 'W-01', repo: 'other' }), task('T-2', { workerId: 'W-02' })];
  assert.equal(pickWorker(ws, tasks, nt(), MODEL, NOW)?.worker.id, 'W-02');
  assert.equal(pickWorker([ws[0]], tasks, nt(), MODEL, NOW), null);
  assert.equal(pickWorker(ws, tasks, nt({ repo: null }), MODEL, NOW), null, 'a code task with no repository has no worktree to reuse');
});

test('routing: busy, open-work, near-compaction, archived and other-model Workers are left out', () => {
  const ws = [
    worker('W-01', { status: 'running' }),
    worker('W-02'),
    worker('W-03', { contextTokens: REUSE_MAX_CONTEXT }),
    worker('W-04', { status: 'archived' }),
    worker('W-05', { model: 'claude-sonnet-5-5' }),
    worker('W-06', { status: 'error' }),
  ];
  const tasks = [task('T-1', { workerId: 'W-02', status: 'pr_open' }), task('T-2', { workerId: 'W-02', status: 'blocked' })];
  assert.equal(pickWorker(ws, tasks, nt(), MODEL, NOW), null);
  assert.equal(reuseBlock(ws[0], tasks), 'busy');
  assert.equal(reuseBlock(ws[1], tasks), 'has open work');
  assert.equal(reuseBlock(ws[2], tasks), `context ${REUSE_MAX_CONTEXT / 1000}K is near compaction`);
  assert.equal(reuseBlock(ws[3], tasks), 'archived');
  assert.equal(reuseBlock(ws[5], tasks), 'stopped with an error');
  // A PR in review does not hold the Worker: review comments come back as a new turn on the same task.
  assert.equal(reuseBlock(ws[1], [task('T-1', { workerId: 'W-02', status: 'pr_open' })]), null);
});

test('routing: the New work line says when an idle Worker is compacted before the task it takes', () => {
  assert.equal(newWorkLine(worker('W-01', { contextTokens: WORKER_TASK_COMPACT - 1 }), []), 'can take it');
  assert.equal(newWorkLine(worker('W-01', { contextTokens: 90_000 }), []), 'can take it (context 90K is compacted before it starts)');
  assert.equal(newWorkLine(worker('W-01', { contextTokens: REUSE_MAX_CONTEXT }), []), `context ${REUSE_MAX_CONTEXT / 1000}K is near compaction`);
  assert.equal(newWorkLine(worker('W-01', { status: 'running', contextTokens: 90_000 }), []), 'busy');
});

test('routing: the Worker that did related work wins over a fresher one', () => {
  const ws = [worker('W-01', { lastActiveAt: hoursAgo(1), contextTokens: 20_000 }), worker('W-02', { lastActiveAt: hoursAgo(50) })];
  const tasks = [
    task('T-1', { workerId: 'W-01', title: 'Scrollbar shows only while scrolling' }),
    task('T-2', { workerId: 'W-02', title: 'Same PR listed twice in PRs in review', summary: 'prmonitor watches each PR once; merge cleanup for all tasks' }),
  ];
  const ranked = rankWorkers(ws, tasks, nt({ prompt: 'The prmonitor watch list and the merge cleanup run twice.' }), MODEL, NOW);
  assert.deepEqual(ranked.map((c) => c.worker.id), ['W-02', 'W-01']);
  assert.ok(ranked[0].related.includes('prmonitor'));
  assert.equal(ranked[0].related[0], 'prmonitor', 'longest words first');
});

test('routing: with nothing related, more history in the repository and less context decide', () => {
  const ws = [worker('W-01', { contextTokens: 120_000 }), worker('W-02', { contextTokens: 10_000 })];
  const tasks = [task('T-1', { workerId: 'W-01' }), task('T-2', { workerId: 'W-02' })];
  assert.equal(pickWorker(ws, tasks, nt({ title: 'Unrelated thing' }), MODEL, NOW)?.worker.id, 'W-02');
  const more = [...tasks, task('T-3', { workerId: 'W-01' }), task('T-4', { workerId: 'W-01' }), task('T-5', { workerId: 'W-01' })];
  assert.equal(pickWorker([worker('W-01', { contextTokens: 60_000 }), ws[1]], more, nt({ title: 'Unrelated thing' }), MODEL, NOW)?.worker.id, 'W-01');
});

test('routing: a non-code task with a repository goes to a Worker that worked there', () => {
  const ws = [worker('W-01', { repo: null }), worker('W-02', { repo: null })];
  const tasks = [task('T-1', { workerId: 'W-01', kind: 'other', repo: 'demo' }), task('T-2', { workerId: 'W-02', kind: 'other', repo: 'docs' })];
  assert.equal(pickWorker(ws, tasks, nt({ kind: 'other' }), MODEL, NOW)?.worker.id, 'W-01');
});

test('routing: a task with no repository needs a few words in common', () => {
  const ws = [worker('W-01', { repo: null })];
  const tasks = [task('T-1', { workerId: 'W-01', kind: 'other', repo: null, title: 'Compare Electron notification libraries', summary: 'toast options on Windows' })];
  assert.equal(pickWorker(ws, tasks, nt({ kind: 'other', repo: null, title: 'Electron notification sounds on Windows' }), MODEL, NOW)?.worker.id, 'W-01');
  assert.equal(pickWorker(ws, tasks, nt({ kind: 'other', repo: null, title: 'Draft the release notes' }), MODEL, NOW), null);
  assert.equal(pickWorker(ws, tasks, nt({ kind: 'other', repo: null, title: 'Electron menu bar' }), MODEL, NOW), null, 'one shared word is not enough');
});

test('routing: the pick is explained for the Dispatcher', () => {
  const c = pickWorker([worker('W-02')], [task('T-2', { workerId: 'W-02', title: 'prmonitor merge cleanup' })], nt({ prompt: 'prmonitor merge' }), MODEL, NOW)!;
  assert.equal(describePick(c, 'demo'), 'knows demo from 1 task(s); related: prmonitor, merge; context 40K');
  assert.equal(describePick({ ...c, related: [] }, null), 'did related work; context 40K');
});
