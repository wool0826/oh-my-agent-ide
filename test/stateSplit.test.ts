import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SPLIT, applySealed, chatOrder, chatToDrop, coverCounters, expected, foldLines, foldToLines, joinState, noneSealed,
  repairFold, sealedFrom, splitState, taskOrder, toSplit, toV1, type Sealed,
} from '../src/shared/stateSplit';
import type { ChatItem, Task } from '../src/shared/types';

const NOW = Date.parse('2026-11-26T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const HOUR = 3600_000;

const task = (n: number, status: Task['status'] = 'done', more: Partial<Task> = {}): Task => ({
  id: `T-${String(n).padStart(4, '0')}`, title: `task ${n}`, prompt: `do ${n}`, kind: 'code', repo: 'app', workerId: 'W-01', status,
  branch: null, prUrl: null, prState: null, summary: null, files: [], createdAt: ago(5 * HOUR), updatedAt: ago(2 * HOUR),
  finishedAt: status === 'done' ? ago(2 * HOUR) : null, reviewSyncedAt: null, seenCommentIds: [], ...more,
});
const said = (n: number, more: Partial<ChatItem> = {}): ChatItem => ({ id: `c${n}`, ts: new Date(NOW - HOUR + n * 1000).toISOString(), kind: 'user', text: `message ${n}`, ...more });
const chatOf = (n: number, from = 0) => Array.from({ length: n }, (_x, i) => said(from + i));

interface State { version: number; counters: { worker: number; task: number }; tasks: Task[]; chat: ChatItem[]; repos: string[] }
const state = (tasks: Task[], chat: ChatItem[]): State => ({ version: 2, counters: { worker: 1, task: tasks.length }, tasks, chat, repos: ['app'] });

/** The three files as text, and what a save and a start do to them. */
interface Disk { main: string; tasks: string; chat: string }
const noDisk = (): Disk => ({ main: '{}', tasks: '', chat: '' });
const append = (text: string, lines: string[]) => (lines.length ? text + lines.join('\n') + '\n' : text);

/** A save: the files first, then state.json; `dies` stops it between the two. */
function save(s: State, sealed: Sealed, disk: Disk, now = NOW, dies = false) {
  const split = splitState(s, sealed, now);
  disk.tasks = append(disk.tasks, split.taskLines);
  applySealed(sealed, split, 'tasks');
  disk.chat = append(disk.chat, split.chatLines);
  applySealed(sealed, split, 'chat');
  if (!dies) disk.main = JSON.stringify(split.main);
  return split;
}

function start(disk: Disk): { state: State; sealed: Sealed } {
  const tasks = foldLines<Task>(disk.tasks), chat = foldLines<ChatItem>(disk.chat);
  return { state: joinState(JSON.parse(disk.main), tasks, chat) as unknown as State, sealed: sealedFrom(tasks, chat) };
}

test('stateSplit: a file reads as its records, each as its last line and where it first stood', () => {
  const f = foldLines<{ id: string; v: number }>('{"id":"a","v":1}\n{"id":"b","v":1}\r\n\n{"id":"a","v":2}\n');
  assert.deepEqual(f.items, [{ id: 'a', v: 2 }, { id: 'b', v: 1 }]);
  assert.equal(f.bad, 0);
  assert.deepEqual(foldLines('﻿{"id":"a"}\n').items, [{ id: 'a' }], 'a byte order mark is not part of the first line');
  assert.deepEqual(foldLines(''), { items: [], open: new Set(), bad: 0 });
});

test('stateSplit: lines that cannot be read are skipped and counted, a cut-off last line too', () => {
  const f = foldLines<{ id: string }>('{"id":"a"}\nnot json\n[1]\n{"no":"id"}\n{"id":""}\n{"id":"b"}\n{"id":"c","text":"cut o');
  assert.deepEqual(f.items.map((x) => x.id), ['a', 'b']);
  assert.equal(f.bad, 5);
});

test('stateSplit: an $open line marks a task as back at work until its next record', () => {
  assert.deepEqual([...foldLines('{"id":"T-1"}\n{"$open":"T-1"}\n').open], ['T-1']);
  assert.deepEqual([...foldLines('{"id":"T-1"}\n{"$open":"T-1"}\n{"id":"T-1","v":2}\n').open], []);
  assert.deepEqual([...foldLines('{"$open":"T-9"}\n').open], [], 'a mark for a task the file never held means nothing');
  const f = foldLines<{ id: string }>('{"id":"T-1"}\n{"id":"T-2"}\n{"$open":"T-2"}\n');
  assert.deepEqual(foldLines(foldToLines(f).join('\n')), f, 'written out again, it reads the same');
});

test('stateSplit: tasks that ended a while ago leave state.json; the rest stay', () => {
  const tasks = [
    task(1), task(2, 'running'), task(3, 'failed'), task(4, 'cancelled'), task(5, 'pr_open'),
    task(6, 'done', { finishedAt: ago(60_000), updatedAt: ago(60_000) }),
    task(7, 'done', { finishedAt: ago(2 * HOUR), updatedAt: ago(30_000) }),
    task(8, 'failed', { finishedAt: null, updatedAt: 'no date' }),
  ];
  const s = splitState(state(tasks, []), noneSealed(), NOW);
  assert.deepEqual(s.main.tasks.map((t) => t.id), ['T-0002', 'T-0005', 'T-0006', 'T-0007'], 'running, with an open PR, just ended, just changed');
  assert.deepEqual(s.taskLines.map((l) => JSON.parse(l).id), ['T-0001', 'T-0003', 'T-0004', 'T-0008']);
  assert.deepEqual(s.main.sealed, { chat: 0, tasks: 4 });
  // The one that ended a minute ago goes once the time has passed.
  const later = splitState(state(tasks, []), noneSealed(), NOW + SPLIT.settle);
  assert.ok(!later.main.tasks.some((t) => t.id === 'T-0006' || t.id === 'T-0007'));
});

test('stateSplit: the chat tail stays in state.json; beyond its limit the oldest leave, down to the smaller size', () => {
  const few = splitState(state([], chatOf(SPLIT.tailMax)), noneSealed(), NOW);
  assert.equal(few.chatLines.length, 0);
  assert.equal(few.main.chat.length, SPLIT.tailMax);
  const many = splitState(state([], chatOf(SPLIT.tailMax + 1)), noneSealed(), NOW);
  assert.equal(many.main.chat.length, SPLIT.tailMin);
  assert.equal(many.chatLines.length, SPLIT.tailMax + 1 - SPLIT.tailMin);
  assert.equal(JSON.parse(many.chatLines[0]).id, 'c0', 'oldest first');
  assert.equal(many.main.chat[0].id, `c${SPLIT.tailMax + 1 - SPLIT.tailMin}`);
  assert.deepEqual(many.main.sealed, { chat: many.chatLines.length, tasks: 0 });
});

test('stateSplit: chat does not leave past a shell run that still changes', () => {
  const run = (sent: 'wait' | 'queued' | 'sent', running: boolean) => ({ cmd: 'npm test', repo: '', running, stopped: false, code: null, startedAt: ago(1000), ms: 0, out: '', lines: 0, sent });
  const chat = chatOf(150);
  chat[10] = said(10, { kind: 'shell', shell: run('wait', true) });
  const s = splitState(state([], chat), noneSealed(), NOW);
  assert.equal(s.chatLines.length, 10, 'only what was said before the run');
  assert.equal(s.main.chat[0].id, 'c10');
  chat[10] = said(10, { kind: 'shell', shell: run('queued', false) });
  assert.equal(splitState(state([], chat), noneSealed(), NOW).chatLines.length, 10, 'ended, but the Dispatcher has not taken it');
  chat[10] = said(10, { kind: 'shell', shell: run('sent', false) });
  assert.equal(splitState(state([], chat), noneSealed(), NOW).chatLines.length, 100);
});

test('stateSplit: split and put together again, the state is the one that was saved', () => {
  const s = state([task(1), task(2, 'running'), task(3, 'failed'), task(4), task(5, 'queued')], chatOf(260));
  const disk = noDisk();
  const split = save(s, noneSealed(), disk);
  assert.ok(split.main.tasks.length === 2 && split.main.chat.length === SPLIT.tailMin);
  assert.deepEqual(start(disk).state, s);
  assert.deepEqual(Object.keys(start(disk).state), Object.keys(s), 'the keys in their order, so the old file can be written back as it was');
  assert.deepEqual(toV1(start(disk).state), { ...s, version: 1 });
});

test('stateSplit: a save with nothing new appends nothing', () => {
  const s = state([task(1), task(2, 'running')], chatOf(130));
  const disk = noDisk(), sealed = noneSealed();
  save(s, sealed, disk);
  const again = save(s, sealed, disk);
  assert.deepEqual([again.taskLines, again.chatLines], [[], []]);
  assert.deepEqual(again.main.sealed, { chat: 80, tasks: 1 });
  // After a start too: what was read is what is in memory.
  const run = start(disk);
  const third = save(run.state, run.sealed, disk);
  assert.deepEqual([third.taskLines, third.chatLines], [[], []]);
});

test('stateSplit: a record that changed after it left gets a new line, which takes the old one\'s place', () => {
  const s = state([task(1), task(2), task(3, 'running')], chatOf(130).map((c, i) => (i === 5 ? { ...c, kind: 'result' as const } : c)));
  const disk = noDisk(), sealed = noneSealed();
  save(s, sealed, disk);
  s.tasks[0].summary = 'merged after all';
  s.chat[5].cleared = true;
  const split = save(s, sealed, disk);
  assert.deepEqual(split.taskLines.map((l) => JSON.parse(l).id), ['T-0001']);
  assert.deepEqual(split.chatLines.map((l) => JSON.parse(l).id), ['c5']);
  assert.deepEqual(split.main.sealed, { chat: 80, tasks: 2 }, 'the same records, not more of them');
  const run = start(disk);
  assert.deepEqual(run.state, s);
  assert.equal(run.state.chat[5].cleared, true);
});

test('stateSplit: a finished task that goes back to work is in state.json again, and leaves again when it ends', () => {
  const s = state([task(1), task(2)], []);
  const disk = noDisk(), sealed = noneSealed();
  save(s, sealed, disk);
  // A follow-up reopens it.
  Object.assign(s.tasks[0], { status: 'running', updatedAt: ago(0) });
  const reopened = save(s, sealed, disk);
  assert.deepEqual(reopened.taskLines, ['{"$open":"T-0001"}']);
  assert.deepEqual(reopened.main.tasks.map((t) => t.id), ['T-0001']);
  assert.deepEqual(save(s, sealed, disk).taskLines, [], 'marked once');
  assert.deepEqual(start(disk).state, s);
  assert.equal(start(disk).state.tasks[0].status, 'running');
  // It ends again: in state.json while it settles, then a new line.
  Object.assign(s.tasks[0], { status: 'done', summary: 'second report', finishedAt: ago(0), updatedAt: ago(0) });
  assert.deepEqual(save(s, sealed, disk).taskLines, []);
  const done = save(s, sealed, disk, NOW + SPLIT.settle);
  assert.deepEqual(done.taskLines.map((l) => JSON.parse(l).summary), ['second report']);
  assert.deepEqual(done.main.tasks, []);
  assert.deepEqual(start(disk).state, s);
});

test('stateSplit: the app dies between the two writes: nothing is lost and nothing is there twice', () => {
  const s = state([task(1, 'running'), task(2, 'running')], chatOf(90));
  const disk = noDisk(), sealed = noneSealed();
  save(s, sealed, disk);
  // T-0001 ends and more is said; the files get their lines, state.json is never written.
  Object.assign(s.tasks[0], { status: 'done', summary: 'done', finishedAt: ago(20 * 60_000), updatedAt: ago(20 * 60_000) });
  s.chat.push(...chatOf(40, 90));
  const died = save(s, sealed, disk, NOW, true);
  assert.ok(died.taskLines.length === 1 && died.chatLines.length === 80);
  const run = start(disk);
  assert.deepEqual(run.state.tasks.map((t) => [t.id, t.status]), [['T-0001', 'done'], ['T-0002', 'running']], 'the finished one from the file, once');
  assert.deepEqual(run.state.chat.map((c) => c.id), chatOf(90).map((c) => c.id), 'state.json still had the first 90; the 40 said in the last moment were never saved');
  assert.equal(new Set(run.state.chat.map((c) => c.id)).size, 90);
  // The next save of that run settles it.
  const next = save(run.state, run.sealed, disk);
  assert.deepEqual([next.taskLines, next.chatLines], [[], []]);
  assert.deepEqual(start(disk).state, run.state);
});

test('stateSplit: the app dies after the $open line: the task is as it was when it ended', () => {
  const s = state([task(1), task(2, 'running')], []);
  const disk = noDisk(), sealed = noneSealed();
  save(s, sealed, disk);
  const before = structuredClone(s);
  Object.assign(s.tasks[0], { status: 'running' });
  save(s, sealed, disk, NOW, true);
  assert.deepEqual(start(disk).state, before);
});

test('stateSplit: a state.json from an older day joins files that went on: the files win, and no id is handed out twice', () => {
  const s = state([task(1, 'running'), task(2, 'pr_open')], chatOf(60));
  const disk = noDisk(), sealed = noneSealed();
  save(s, sealed, disk);
  const yesterday = disk.main;
  Object.assign(s.tasks[0], { status: 'done', finishedAt: ago(HOUR), updatedAt: ago(HOUR) });
  s.tasks.push(task(3, 'failed'), task(4, 'running'));
  s.counters.task = 4;
  s.chat.push(...chatOf(120, 60));
  save(s, sealed, disk);
  disk.main = yesterday;
  const run = start(disk).state;
  assert.deepEqual(run.tasks.map((t) => [t.id, t.status]), [['T-0001', 'done'], ['T-0002', 'pr_open'], ['T-0003', 'failed']]);
  assert.equal(run.counters.task, 3, 'T-0004 was only in the newer state.json; T-0003 is not handed out again');
  assert.equal(run.chat.length, 130, 'what reached the file');
});

test('stateSplit: records without an id of their own stay in state.json', () => {
  const twin = task(1), other = task(1, 'done', { title: 'same id' });
  const noId = task(2, 'done', { id: undefined as unknown as string });
  const chat = chatOf(150);
  chat[3] = { ...chat[3], id: '' };
  chat[7] = { ...chat[7], id: 'c8' };
  const s = state([twin, other, noId, task(3)], chat);
  const disk = noDisk();
  const split = save(s, noneSealed(), disk);
  assert.deepEqual(split.main.tasks, [twin, other, noId]);
  assert.deepEqual(split.main.chat.slice(0, 3), [chat[3], chat[7], chat[8]]);
  const run = start(disk).state;
  assert.equal(run.tasks.length, 4);
  assert.equal(run.chat.length, 150, 'none lost');
});

test('stateSplit: the oldest chat leaves memory only once it is in the file', () => {
  const chat = chatOf(30);
  const sealed = noneSealed();
  assert.equal(chatToDrop(chat, sealed, 10), 0, 'nothing is in the file yet');
  for (const c of chat.slice(0, 12)) sealed.chat.set(c.id, JSON.stringify(c));
  assert.equal(chatToDrop(chat, sealed, 10), 12, 'as far as the file goes');
  assert.equal(chatToDrop(chat, sealed, 25), 5);
  assert.equal(chatToDrop(chat, sealed, 30), 0);
});

test('stateSplit: what state.json expects of the files, and the order records go back in', () => {
  assert.deepEqual(expected({ sealed: { chat: 3, tasks: 2 } }), { chat: 3, tasks: 2 });
  assert.deepEqual(expected({}), { chat: 0, tasks: 0 });
  assert.deepEqual(expected({ sealed: { chat: 'x', tasks: -1 } }), { chat: 0, tasks: 0 });
  assert.deepEqual([{ id: 'T-0010' }, { id: 'odd' }, { id: 'T-0002' }, { id: 'T-10000' }].sort(taskOrder).map((x) => x.id), ['T-0002', 'T-0010', 'T-10000', 'odd']);
  assert.deepEqual([{ ts: '2026-11-02' }, {}, { ts: '2026-11-01' }].sort(chatOrder), [{}, { ts: '2026-11-01' }, { ts: '2026-11-02' }]);
  assert.deepEqual(coverCounters({ counters: { worker: 1, task: 2 }, tasks: [{ id: 'T-0007' }, { id: 'x' }] }).counters, { worker: 1, task: 7 });
  const fine = { counters: { worker: 1, task: 9 }, tasks: [{ id: 'T-0007' }] };
  assert.equal(coverCounters(fine), fine);
  assert.deepEqual(coverCounters({ tasks: [{ id: 'T-0007' }] }), { tasks: [{ id: 'T-0007' }] });
});

test('stateSplit: a file that lost records gets them back from a backup, in their place; what it has stays', () => {
  const whole = foldLines<ChatItem>(chatOf(6).map((c) => JSON.stringify(c)).join('\n'));
  const cut = foldLines<ChatItem>([said(0), { ...said(1), text: 'newer' }, said(4), said(6)].map((c) => JSON.stringify(c)).join('\n'));
  const r = repairFold(cut, whole, chatOrder);
  assert.equal(r.restored, 3);
  assert.deepEqual(r.fold.items.map((c) => c.id), ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6']);
  assert.equal(r.fold.items[1].text, 'newer');
  assert.deepEqual(repairFold(whole, cut, chatOrder), { fold: repairFold(whole, cut, chatOrder).fold, restored: 1 });
  assert.equal(repairFold(whole, whole, chatOrder).fold, whole, 'nothing to put back');
  // A task the backup last saw as back at work comes back that way.
  const tasks = repairFold(foldLines<Task>('{"id":"T-0002"}\n'), foldLines<Task>('{"id":"T-0001"}\n{"$open":"T-0001"}\n{"id":"T-0002"}\n{"$open":"T-0002"}\n'), taskOrder);
  assert.deepEqual(tasks.fold.items.map((t) => t.id), ['T-0001', 'T-0002']);
  assert.deepEqual([...tasks.fold.open], ['T-0001'], 'the file\'s own record of T-0002 is newer than the backup\'s mark');
});

test('stateSplit: the step to version 2 wants lists of records and gives chat without an id of its own one', () => {
  const s: Record<string, unknown> = { chat: [{ id: 'a' }, { text: 'no id' }, { id: 'a', text: 'twin' }, { id: 'old-1' }, { id: 7 }] };
  toSplit(s);
  assert.deepEqual(s.tasks, []);
  assert.deepEqual((s.chat as { id: string }[]).map((c) => c.id), ['a', 'old-1-1', 'old-2', 'old-1', 'old-4']);
  const none: Record<string, unknown> = { chat: null };
  toSplit(none);
  assert.deepEqual(none, { chat: [], tasks: [] });
  assert.throws(() => toSplit({ tasks: {} }), /"tasks" is not a list/);
  assert.throws(() => toSplit({ chat: 'hello' }), /"chat" is not a list/);
  assert.throws(() => toSplit({ tasks: [], chat: [{ id: 'a' }, null] }), /"chat" holds something that is not a record/);
  assert.throws(() => toSplit({ tasks: [['T-1']] }), /"tasks" holds something that is not a record/);
});

test('stateSplit: the step to version 2 puts tasks in the order of their numbers', () => {
  const s: Record<string, unknown> = { version: 1, tasks: [task(3), task(1), { title: 'no id' }, task(2), task(1, 'running')], chat: [] };
  toSplit(s);
  assert.deepEqual((s.tasks as Task[]).map((t) => `${t.id ?? '-'} ${t.status ?? '-'}`), ['T-0001 done', 'T-0001 running', 'T-0002 done', 'T-0003 done', '- -']);
});

test('stateSplit: a large state splits, reads back the same and saves again with nothing to append', (t) => {
  const tasks = Array.from({ length: 5000 }, (_x, i) => task(i + 1, i % 50 === 0 ? 'running' : i % 7 === 0 ? 'failed' : 'done', { prompt: 'p'.repeat(1200), summary: 's'.repeat(300) }));
  const chat = Array.from({ length: 20_000 }, (_x, i) => said(i, { text: 'm'.repeat(300) }));
  const s = state(tasks, chat);
  const disk = noDisk(), sealed = noneSealed();
  let at = performance.now();
  const split = save(s, sealed, disk);
  const first = performance.now() - at;
  assert.equal(split.main.tasks.length, 100);
  assert.equal(split.main.chat.length, SPLIT.tailMin);
  at = performance.now();
  const run = start(disk);
  const read = performance.now() - at;
  assert.deepEqual(run.state, s);
  at = performance.now();
  const again = save(s, sealed, disk);
  const next = performance.now() - at;
  assert.deepEqual([again.taskLines, again.chatLines], [[], []]);
  const mb = (n: number) => (n / 1048576).toFixed(1);
  t.diagnostic(`5,000 tasks and 20,000 chat items: whole ${mb(JSON.stringify(s).length)} MB, state.json ${mb(disk.main.length)} MB; first split ${first.toFixed(0)} ms, read back ${read.toFixed(0)} ms, a later save ${next.toFixed(0)} ms`);
});

test('stateSplit: whatever is done and wherever the app dies, every record saved is there once', () => {
  // A small generator with a fixed seed, so a failure can be run again.
  let seed = 20261126;
  const rnd = (n: number) => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) % n;
  };
  const disk = noDisk();
  let s = state([], []);
  let sealed = noneSealed();
  let now = NOW;
  let nextChat = 0;
  const saved = { tasks: new Set<string>(), chat: new Set<string>() };
  for (let round = 0; round < 400; round++) {
    now += 4 * 60_000;
    for (let i = rnd(30); i > 0; i--) s.chat.push(said(nextChat++, { ts: new Date(now).toISOString() }));
    if (rnd(2)) { s.counters.task += 1; s.tasks.push(task(s.counters.task, 'running', { updatedAt: new Date(now).toISOString() })); }
    const pick = s.tasks.length ? s.tasks[rnd(s.tasks.length)] : null;
    if (pick) {
      const to = (['done', 'failed', 'running', 'cancelled'] as const)[rnd(4)];
      Object.assign(pick, { status: to, updatedAt: new Date(now).toISOString(), finishedAt: to === 'done' ? new Date(now).toISOString() : pick.finishedAt });
    }
    if (s.chat.length && rnd(3) === 0) s.chat[rnd(s.chat.length)].cleared = true;
    const dies = rnd(5) === 0;
    save(s, sealed, disk, now, dies);
    if (!dies) { for (const t of s.tasks) saved.tasks.add(t.id); for (const c of s.chat) saved.chat.add(c.id); }
    if (dies || rnd(10) === 0) {
      // The next start: what the files give is what the app goes on with.
      ({ state: s, sealed } = start(disk));
      const taskIds = s.tasks.map((t) => t.id), chatIds = s.chat.map((c) => c.id);
      assert.equal(new Set(taskIds).size, taskIds.length, `round ${round}: a task twice`);
      assert.equal(new Set(chatIds).size, chatIds.length, `round ${round}: a chat item twice`);
      for (const id of saved.tasks) assert.ok(taskIds.includes(id), `round ${round}: ${id} lost`);
      const have = new Set(chatIds);
      for (const id of saved.chat) assert.ok(have.has(id), `round ${round}: chat ${id} lost`);
      assert.deepEqual(taskIds, [...taskIds].sort(), `round ${round}: tasks out of order`);
      assert.deepEqual(s.chat.map((c) => c.ts), s.chat.map((c) => c.ts).sort(), `round ${round}: chat out of order`);
      assert.ok(s.counters.task >= s.tasks.length, `round ${round}: the counter fell behind`);
      // What was only in memory when it died may be gone; ids made from here on must be new.
      nextChat += 1000;
    }
  }
  assert.ok(saved.tasks.size > 100 && saved.chat.size > 3000, `the run did something: ${saved.tasks.size} tasks, ${saved.chat.size} chat items`);
});
