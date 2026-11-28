import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPACT_STALE_MS, REUSE_MAX_CONTEXT, contextCost, describePick, keywords, lateBind, newWorkLine, pickWorker, rankWorkers, rerunWorker, reuseBlock, startWorker, type NewTask } from '../src/shared/routing';
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

test('routing: busy, open-work, compacting, archived and other-model Workers are left out', () => {
  const ws = [
    worker('W-01', { status: 'running' }),
    worker('W-02'),
    worker('W-03', { compactingSince: hoursAgo(0.1) }),
    worker('W-04', { status: 'archived' }),
    worker('W-05', { model: 'claude-sonnet-5-5' }),
    worker('W-06', { status: 'error' }),
  ];
  const tasks = [task('T-1', { workerId: 'W-02', status: 'pr_open' }), task('T-2', { workerId: 'W-02', status: 'blocked' })];
  assert.equal(pickWorker(ws, tasks, nt(), MODEL, NOW), null);
  assert.equal(reuseBlock(ws[0], tasks), 'busy');
  assert.equal(reuseBlock(ws[1], tasks), 'has open work');
  assert.equal(reuseBlock(ws[2], tasks, NOW), 'compacting its context');
  // A compaction whose end never came does not hold the Worker for good.
  assert.equal(reuseBlock(worker('W-03', { compactingSince: new Date(NOW - COMPACT_STALE_MS).toISOString() }), [], NOW), null);
  assert.equal(reuseBlock(ws[3], tasks), 'archived');
  assert.equal(reuseBlock(ws[5], tasks), 'stopped with an error');
  // A PR in review does not hold the Worker: review comments come back as a new turn on the same task.
  assert.equal(reuseBlock(ws[1], [task('T-1', { workerId: 'W-02', status: 'pr_open' })]), null);
});

test('routing: the New work line says when an idle Worker is compacted before the task it takes', () => {
  assert.equal(newWorkLine(worker('W-01', { contextTokens: WORKER_TASK_COMPACT - 1 }), []), 'can take it');
  assert.equal(newWorkLine(worker('W-01', { contextTokens: 90_000 }), []), 'can take it (context 90K is compacted before it starts)');
  assert.equal(newWorkLine(worker('W-01', { contextTokens: 200_000 }), []), 'can take it (context 200K is compacted before it starts)');
  assert.equal(newWorkLine(worker('W-01', { status: 'running', contextTokens: 90_000 }), []), 'busy');
});

// T-0154: a Worker is compacted before a new task starts, so its context size alone never keeps it from the task.
const SIZES = [10_000, 60_000, 150_000, 200_000];
const relatedWork = (id: string) => task(`T-${id}`, { workerId: id, title: 'PR monitor shows merged PR state', summary: 'prmonitor merged twice' });
const otherWork = (id: string) => task(`T-${id}`, { workerId: id, title: 'Scrollbar fades while scrolling' });

test('routing: context 10K/60K/150K/200K, related or not, idle or compacting (T-0154)', () => {
  for (const contextTokens of SIZES) {
    for (const [what, work] of [['related', relatedWork], ['unrelated', otherWork]] as const) {
      const idle = worker('W-01', { contextTokens });
      const compacting = worker('W-01', { contextTokens, compactingSince: hoursAgo(0.1) });
      const tasks = [work('W-01')];
      const at = `${contextTokens / 1000}K ${what}`;
      assert.equal(reuseBlock(idle, tasks, NOW), null, at);
      assert.equal(pickWorker([idle], tasks, nt(), MODEL, NOW)?.worker.id, 'W-01', at);
      assert.equal(newWorkLine(idle, tasks), contextTokens >= WORKER_TASK_COMPACT ? `can take it (context ${contextTokens / 1000}K is compacted before it starts)` : 'can take it', at);
      assert.equal(reuseBlock(compacting, tasks, NOW), 'compacting its context', at);
      assert.equal(pickWorker([compacting], tasks, nt(), MODEL, NOW), null, at);
    }
  }
});

test('routing: related context wins at any size; unrelated context costs more as it grows (T-0154)', () => {
  for (const contextTokens of SIZES) {
    const related = worker('W-01', { contextTokens });
    const tasks = [relatedWork('W-01'), otherWork('W-02')];
    assert.equal(pickWorker([related, worker('W-02', { contextTokens })], tasks, nt(), MODEL, NOW)?.worker.id, 'W-01', `${contextTokens / 1000}K`);
    assert.equal(pickWorker([related, worker('W-02', { contextTokens: 10_000 })], tasks, nt(), MODEL, NOW)?.worker.id, 'W-01', `${contextTokens / 1000}K vs 10K`);
  }
  const costs = SIZES.map((contextTokens) => contextCost(worker('W-01', { contextTokens })));
  assert.deepEqual(costs, [0.2, 1.6, 2.5, 3]);
  const unrelated = SIZES.map((contextTokens, i) => worker(`W-0${i + 1}`, { contextTokens }));
  const ranked = rankWorkers(unrelated, unrelated.map((w) => otherWork(w.id)), nt(), MODEL, NOW);
  assert.deepEqual(ranked.map((c) => c.worker.contextTokens), SIZES);
});

test('routing: a Codex Worker is not compacted before the task, so from 150K it does not take new work by itself (T-0154)', () => {
  const codex = 'gpt-5.5-codex';
  assert.equal(newWorkLine(worker('W-01', { model: codex, contextTokens: 100_000 }), []), 'can take it');
  assert.equal(contextCost(worker('W-01', { model: codex, contextTokens: 100_000 })), 2);
  assert.equal(reuseBlock(worker('W-01', { model: codex, contextTokens: REUSE_MAX_CONTEXT }), []), 'context 150K cannot be compacted before it starts');
  assert.equal(reuseBlock(worker('W-01', { contextTokens: REUSE_MAX_CONTEXT }), []), null, 'a Claude Worker is compacted first');
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
  assert.equal(describePick({ ...c, worker: worker('W-02', { contextTokens: 150_000 }) }, 'demo'), 'knows demo from 1 task(s); related: prmonitor, merge; context 150K, compacted before it starts');
});

test('routing: a task that cannot start yet waits without a Worker; a pinned one is bound at once (T-0146)', () => {
  const free = { pinned: false, after: false, slotFree: true, accountFree: true };
  assert.equal(lateBind(free), 'now');
  assert.equal(lateBind({ ...free, after: true }), 'blocked');
  assert.equal(lateBind({ ...free, slotFree: false }), 'slot');
  assert.equal(lateBind({ ...free, accountFree: false }), 'limit');
  assert.equal(lateBind({ ...free, after: true, slotFree: false }), 'blocked');
  assert.equal(lateBind({ pinned: true, after: true, slotFree: false, accountFree: false }), 'now');
});

test("routing: a chained task starts on its dependency's Worker when that one passes the filters", () => {
  const ws = [worker('W-01', { lastActiveAt: hoursAgo(0.1) }), worker('W-02', { lastActiveAt: hoursAgo(3) })];
  const tasks = [task('T-1', { workerId: 'W-01', title: 'PR monitor merged state' }), task('T-2', { workerId: 'W-02', prState: 'MERGED' })];
  assert.equal(startWorker(ws, tasks, nt(), MODEL, 'W-02', NOW)?.worker.id, 'W-02');
  assert.equal(startWorker(ws, tasks, nt(), MODEL, null, NOW)?.worker.id, pickWorker(ws, tasks, nt(), MODEL, NOW)?.worker.id);
});

test('routing: a busy, other-model or compacting dependency Worker gives way to the usual pick', () => {
  const tasks = [task('T-1', { workerId: 'W-01' }), task('T-2', { workerId: 'W-02' })];
  for (const patch of [{ status: 'running' as const }, { model: 'claude-sonnet-5-5' }, { compactingSince: hoursAgo(0.1) }]) {
    const ws = [worker('W-01'), worker('W-02', patch)];
    assert.equal(startWorker(ws, tasks, nt(), MODEL, 'W-02', NOW)?.worker.id, 'W-01', JSON.stringify(patch));
  }
  assert.equal(startWorker([worker('W-02', { status: 'running' })], tasks, nt(), MODEL, 'W-02', NOW), null);
});

test('routing: a rerun goes back to the Worker that ran it, even with no words in common and no repository', () => {
  const ws = [worker('W-01', { repo: null }), worker('W-02', { repo: null })];
  const tasks = [task('T-1', { workerId: 'W-01', title: 'First', kind: 'other', repo: null })];
  assert.equal(pickWorker(ws, tasks, nt({ title: 'First', kind: 'other', repo: null }), MODEL, NOW), null);
  assert.equal(rerunWorker(ws, tasks, nt({ title: 'First', kind: 'other', repo: null }), MODEL, 'W-01', NOW)?.worker.id, 'W-01');
});

test('routing: a rerun whose Worker is busy, on another model, archived or in another repository gets the usual pick', () => {
  const tasks = [task('T-1', { workerId: 'W-02' })];
  for (const patch of [{ status: 'running' as const }, { model: 'claude-sonnet-5-5' }, { status: 'archived' as const }, { repo: 'other' }]) {
    const ws = [worker('W-01'), worker('W-02', patch)];
    assert.equal(rerunWorker(ws, tasks, nt(), MODEL, 'W-02', NOW)?.worker.id, pickWorker(ws, tasks, nt(), MODEL, NOW)?.worker.id, JSON.stringify(patch));
  }
  assert.equal(rerunWorker([worker('W-01')], tasks, nt(), MODEL, null, NOW)?.worker.id, 'W-01');
});
