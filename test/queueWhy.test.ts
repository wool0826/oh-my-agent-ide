import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tr } from '../src/shared/i18n';
import type { Say } from '../src/shared/askWhy';
import { ordinal, queueLine, queuePlace, queueWhy, queueWhyText, type QueueCtx } from '../src/shared/queueWhy';
import type { Task } from '../src/shared/types';

const en: Say = (k, v) => tr('en', k, v);
const ko: Say = (k, v) => tr('ko', k, v);
const NOW = Date.parse('2026-11-22T12:00:00Z');
const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();

const T = (id: string, extra: Partial<Task> = {}): Task => ({
  id, title: `Task ${id}`, prompt: 'Do it', kind: 'code', repo: 'demo', workerId: `W-${id}`, status: 'running',
  branch: null, prUrl: null, prState: null, summary: null, files: [], createdAt: iso(60), updatedAt: iso(30),
  finishedAt: null, reviewSyncedAt: null, seenCommentIds: [], ...extra,
});
const slot = (id: string, minAgo: number) => T(id, { status: 'queued', queueReason: 'slot', updatedAt: iso(minAgo) });
const ctx = (tasks: Task[], extra: Partial<QueueCtx> = {}): QueueCtx => ({
  tasks, accounts: [], maxWorkers: 2, now: NOW, time: (ms) => new Date(ms).toISOString().slice(11, 16), ...extra,
});

test('queueWhy: only queued and blocked tasks have a reason', () => {
  assert.equal(queueWhy(en, T('A'), ctx([])), null);
  assert.equal(queueWhy(en, T('A', { status: 'pr_open' }), ctx([])), null);
});

test('queueWhy: a task waiting for a slot says n/max and its place in line', () => {
  const tasks = [T('R1'), T('R2'), slot('Q1', 20), slot('Q2', 5), slot('Q3', 10)];
  assert.deepEqual(queuePlace(tasks, 'Q2'), { pos: 3, total: 3 });
  assert.deepEqual(queuePlace(tasks, 'Q3'), { pos: 2, total: 3 });
  assert.equal(queuePlace(tasks, 'R1'), null);
  const q = queueWhy(en, tasks[4], ctx(tasks))!;
  assert.equal(q.why, 'All 2 Worker slots are in use (2/2).');
  assert.equal(q.starts, 'When a slot frees up; 2 of 3 in line.');
  assert.equal(q.cancelled, false);
  assert.equal(queueWhyText(q), 'All 2 Worker slots are in use (2/2). When a slot frees up; 2 of 3 in line.');
});

test('queueWhy: a free slot means it starts shortly', () => {
  const tasks = [T('R1'), slot('Q1', 3)];
  assert.equal(queueWhy(en, tasks[1], ctx(tasks))!.starts, 'A slot is free, so it starts shortly.');
  // Its Worker already holds a slot (another task of it runs): it may start although all slots are taken.
  const own = [T('R1'), T('R2'), slot('Q1', 3)];
  own[2].workerId = 'W-R2';
  assert.equal(queueWhy(en, own[2], ctx(own))!.starts, 'A slot is free, so it starts shortly.');
});

test('queueWhy: a usage limit names the account that resets first', () => {
  const q = T('L', { status: 'queued', queueReason: 'limit' });
  const accounts = [
    { label: 'Team A', limitedUntil: new Date(NOW + 90 * 60_000).toISOString() },
    { label: 'Team B', limitedUntil: new Date(NOW + 30 * 60_000).toISOString() },
  ];
  const r = queueWhy(en, q, ctx([q], { accounts }))!;
  assert.equal(r.why, 'Every account has hit its usage limit.');
  assert.equal(r.starts, 'When the Team B limit resets at 12:30.');
  // Tasks queued before slots existed have no reason and waited for a limit.
  assert.equal(queueWhy(en, { ...q, queueReason: undefined }, ctx([q], { accounts }))!.starts, r.starts);
});

test('queueWhy: once any account is free again the limit wait ends', () => {
  const q = T('L', { status: 'queued', queueReason: 'limit' });
  const accounts = [{ label: 'Team A', limitedUntil: new Date(NOW + 90 * 60_000).toISOString() }, { label: 'Team B', limitedUntil: iso(5) }];
  assert.equal(queueWhy(en, q, ctx([q], { accounts }))!.starts, 'The limit has reset, so it starts shortly.');
  assert.equal(queueWhy(en, q, ctx([q]))!.starts, 'The limit has reset, so it starts shortly.');
  // Going on still needs a slot.
  const full = [T('R1'), T('R2'), q];
  assert.equal(queueWhy(en, q, ctx(full, { accounts }))!.starts, 'The limit has reset; it starts when one of the 2 Worker slots frees up.');
});

test('queueWhy: a blocked task follows the state of the task it waits for', () => {
  const b = T('B', { status: 'blocked', afterTaskId: 'D' });
  const run = (dep: Task | null) => queueWhy(en, b, ctx(dep ? [dep, b] : [b]))!;

  const open = run(T('D', { status: 'pr_open', prUrl: 'https://github.com/o/r/pull/12', prState: 'OPEN' }));
  assert.equal(open.why, 'It builds on D "Task D", which is not merged yet.');
  assert.equal(open.starts, 'When PR #12 is merged. If it is closed without merging, this task is cancelled.');
  assert.equal(open.cancelled, false);

  const noPr = 'When D opens a PR and it is merged. If D finishes without a PR, it starts then.';
  assert.equal(run(T('D', { status: 'running' })).starts, noPr);
  assert.equal(run(T('D', { status: 'queued', queueReason: 'slot' })).starts, noPr);
  assert.equal(run(T('D', { status: 'done', prUrl: 'https://github.com/o/r/pull/12', prState: 'MERGED' })).starts, 'PR #12 is merged, so it starts shortly.');
  assert.equal(run(T('D', { status: 'done' })).starts, 'D finished without a PR, so it starts shortly.');

  // What afterDependency (decision 92) cancels it for.
  for (const dep of [T('D', { status: 'cancelled' }), T('D', { status: 'failed' }), T('D', { prUrl: 'https://github.com/o/r/pull/12', prState: 'CLOSED', status: 'done' })]) {
    const r = run(dep);
    assert.equal(r.cancelled, true, dep.status);
    assert.equal(r.starts, 'D ended without anything to build on, so this task is cancelled.');
  }
  const gone = run(null);
  assert.equal(gone.cancelled, true);
  assert.equal(gone.why, 'It builds on D, which is not merged yet.');
});

test('queueWhy: a task queued again says what cancelling keeps', () => {
  const tasks = [T('R1'), T('R2')];
  const pr = slot('Q', 4);
  Object.assign(pr, { finishedAt: iso(40), prUrl: 'https://github.com/o/r/pull/7', prState: 'OPEN' });
  assert.equal(queueWhy(en, pr, ctx([...tasks, pr]))!.again, 'It finished once already: cancelling drops only the queued work, and PR #7 stays open.');
  const done = slot('Q', 4);
  done.finishedAt = iso(40);
  assert.equal(queueWhy(en, done, ctx([...tasks, done]))!.again, 'It finished once already: cancelling drops only the queued work.');
  assert.equal(queueWhy(en, slot('Q', 4), ctx(tasks))!.again, null);
});

test('queueWhy: Korean text', () => {
  const tasks = [T('R1'), T('R2'), slot('Q1', 5)];
  const q = queueWhy(ko, tasks[2], ctx(tasks))!;
  assert.equal(q.why, 'Worker 자리 2개가 모두 쓰이고 있어요 (2/2).');
  assert.equal(q.starts, '자리가 나면 시작해요. 대기 1개 중 1번째예요.');
  const b = T('B', { status: 'blocked', afterTaskId: 'D' });
  assert.match(queueWhy(ko, b, ctx([T('D', { status: 'cancelled' }), b]))!.starts, /취소돼요/);
});

test('queueWhy: with a free slot, why and starts agree instead of saying every slot is taken', () => {
  const tasks = [T('R1'), slot('Q1', 3)];
  const q = queueWhy(en, tasks[1], ctx(tasks))!;
  assert.equal(q.why, 'It waited for a Worker slot; one is free now (1/2 in use).');
  assert.doesNotMatch(q.why, /All \d+ Worker slots are in use/);
});

test('queueWhy: Korean task ids and PR numbers are not followed by a particle that may not fit', () => {
  const b = T('B', { status: 'blocked', afterTaskId: 'T-0005' });
  const run = (dep: Task) => queueWhy(ko, b, ctx([dep, b]))!;
  const texts = [
    run(T('T-0005', { status: 'running' })).starts,
    run(T('T-0005', { status: 'done' })).starts,
    run(T('T-0005', { status: 'failed' })).starts,
    run(T('T-0005', { status: 'pr_open', prUrl: 'https://github.com/o/r/pull/12', prState: 'OPEN' })).starts,
    run(T('T-0005', { status: 'done', prUrl: 'https://github.com/o/r/pull/12', prState: 'MERGED' })).starts,
  ];
  for (const s of texts) assert.doesNotMatch(s, /(T-0005|#12)[이가은는을를]/, s);
});

test('queueLine: a task in line shows its place, and the first one that it is next', () => {
  const tasks = [T('R1'), T('R2'), slot('Q1', 20), slot('Q2', 5), slot('Q3', 10)];
  assert.deepEqual(queueLine(en, tasks[2], ctx(tasks)), { pos: 1, text: 'next, when a slot frees', cancelled: false });
  assert.deepEqual(queueLine(en, tasks[4], ctx(tasks)), { pos: 2, text: '2nd in line', cancelled: false });
  assert.deepEqual(queueLine(en, tasks[3], ctx(tasks)), { pos: 3, text: '3rd in line', cancelled: false });
  assert.equal(queueLine(ko, tasks[3], ctx(tasks))!.text, '3번째 차례');
  // A free slot: it keeps its place and starts shortly.
  const free = [T('R1'), slot('Q1', 3)];
  assert.deepEqual(queueLine(en, free[1], ctx(free)), { pos: 1, text: 'starts shortly', cancelled: false });
  assert.equal(queueLine(en, T('A'), ctx([])), null);
});

test('queueLine: a task held by a merge or a usage limit has no place in line', () => {
  const b = T('B', { status: 'blocked', afterTaskId: 'T-0005' });
  const line = (dep: Task) => queueLine(en, b, ctx([dep, b]))!;
  assert.deepEqual(line(T('T-0005', { status: 'running' })), { pos: null, text: 'starts after T-0005', cancelled: false });
  assert.deepEqual(line(T('T-0005', { status: 'pr_open', prUrl: 'https://github.com/o/r/pull/12', prState: 'OPEN' })), { pos: null, text: 'starts when PR #12 merges', cancelled: false });
  assert.deepEqual(line(T('T-0005', { status: 'done', prUrl: 'https://github.com/o/r/pull/12', prState: 'MERGED' })), { pos: null, text: 'starts shortly', cancelled: false });
  assert.deepEqual(line(T('T-0005', { status: 'failed' })), { pos: null, text: 'cannot start: T-0005 ended without a merge', cancelled: true });

  const q = T('L', { status: 'queued', queueReason: 'limit' });
  const accounts = [{ label: 'Team A', limitedUntil: new Date(NOW + 90 * 60_000).toISOString() }, { label: 'Team B', limitedUntil: new Date(NOW + 30 * 60_000).toISOString() }];
  assert.deepEqual(queueLine(en, q, ctx([q], { accounts })), { pos: null, text: 'when the Team B limit resets at 12:30', cancelled: false });
  assert.equal(queueLine(en, q, ctx([q]))!.text, 'starts shortly');
  assert.equal(queueLine(en, q, ctx([T('R1'), T('R2'), q]))!.text, 'limit reset, waiting for a slot');
});

test('ordinal: English places in line', () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal), ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '101st', '111th']);
});
