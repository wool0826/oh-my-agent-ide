import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { flushNow, store } from '../src/main/store';
import { ensureHome, paths } from '../src/main/paths';
import { appendLines, rollbackToV1, writeLines } from '../src/main/stateFiles';
import { SPLIT, foldLines } from '../src/shared/stateSplit';
import type { ChatItem, Task } from '../src/shared/types';

// The store on real files: each test starts from a fixture in test/fixtures/state (a version 1 file, or a folder
// as version 2 keeps it) copied into a data folder of its own.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-statefiles-'));
process.env.OMA_DATA_DIR = tmp;
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ home: path.join(tmp, 'home'), language: 'en' }));

const FIXTURES = path.join('test', 'fixtures', 'state');
const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

/** The data folder holds this and nothing else: a fixture folder as it is, or one file's text as state.json. */
function seed(from: { folder: string } | { state: string }) {
  fs.rmSync(paths().data, { recursive: true, force: true });
  ensureHome();
  if ('folder' in from) fs.cpSync(path.join(FIXTURES, from.folder), paths().data, { recursive: true });
  else fs.writeFileSync(paths().state, from.state);
}

const text = (file: string) => fs.readFileSync(file, 'utf8');
const main = () => JSON.parse(text(paths().state)) as { version: number; tasks: Task[]; chat: ChatItem[]; sealed?: { chat: number; tasks: number }; counters: { task: number } };
const doneFile = () => foldLines<Task>(text(paths().tasksDone));
const chatFile = () => foldLines<ChatItem>(text(paths().chatFile));
const ids = (xs: readonly { id: string }[]) => xs.map((x) => x.id);
const inData = (start: string) => fs.readdirSync(paths().data).filter((f) => f.startsWith(start)).sort();
/** The state in memory as plain data, the way it compares with a parsed file. */
const whole = () => JSON.parse(JSON.stringify(store.data));
const HOUR = 3600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const task = (n: number, status: Task['status'] = 'done'): Task => ({
  id: `T-${String(n).padStart(4, '0')}`, title: `Task ${n}`, prompt: `Do thing ${n}`, kind: 'code', repo: 'app', workerId: 'W-01', status,
  branch: null, prUrl: null, prState: null, summary: status === 'done' ? `Summary of ${n}: ${'done and checked. '.repeat(20)}` : null, files: [],
  createdAt: '2026-10-01T09:00:00.000Z', updatedAt: '2026-10-01T10:00:00.000Z', finishedAt: status === 'running' ? null : '2026-10-01T10:00:00.000Z',
  reviewSyncedAt: null, seenCommentIds: [],
});
const said = (n: number, textOf = `message ${n}`): ChatItem => ({ id: `c${n}`, ts: new Date(Date.UTC(2026, 9, 1) + n * 1000).toISOString(), kind: n % 2 ? 'dispatcher' : 'user', text: textOf });

/** A version 1 state of any size, as the file an older build wrote. */
function v1(tasks: Task[], chat: ChatItem[]): string {
  return JSON.stringify({ ...JSON.parse(fixture('v1.json')), counters: { worker: 2, task: tasks.length }, tasks, chat }, null, 2);
}

/** A save that stops where the app could die: `at` names the file whose write never happens. */
function failing<T>(at: 'state.json' | 'tasks-done.jsonl' | 'chat.jsonl', run: () => T): T {
  const rename = fs.renameSync;
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    if (path.basename(String(to)) === at) throw new Error(`stopped before ${at}`);
    rename(from, to);
  }) as typeof fs.renameSync;
  try { return run(); } finally { fs.renameSync = rename; }
}

test('store: a version 1 state is split on load, after a copy of it is kept', () => {
  const V1 = fixture('v1-history.json');
  seed({ state: V1 });
  store.load();
  assert.equal(store.readOnly, null);
  assert.equal(store.migrated?.from, 1);
  assert.equal(text(store.migrated!.copy), V1, 'the file as it was');
  assert.deepEqual(whole(), { ...JSON.parse(V1), version: 2 }, 'in memory nothing moved');
  // On disk: what is live in state.json, what ended in tasks-done.jsonl.
  const m = main();
  assert.equal(m.version, 2);
  assert.deepEqual(ids(m.tasks), ['T-0003', 'T-0005']);
  assert.deepEqual(ids(doneFile().items), ['T-0001', 'T-0002', 'T-0004']);
  assert.deepEqual(ids(m.chat), ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'], 'a short chat stays where it is');
  assert.deepEqual(chatFile().items, []);
  assert.deepEqual(m.sealed, { chat: 0, tasks: 3 });
});

test('store: a second start reads the same state back and writes nothing new', () => {
  seed({ state: fixture('v1-history.json') });
  store.load();
  const first = whole();
  const files = [paths().state, paths().tasksDone, paths().chatFile];
  const was = files.map(text);
  store.load();
  assert.equal(store.migrated, null);
  assert.deepEqual(whole(), first);
  assert.equal(flushNow(), true);
  assert.deepEqual(files.map(text), was);
  assert.equal(inData('state-v1-before-v2-').length, 1, 'one copy, from the one migration');
});

test('store: a large version 1 state splits and comes back whole', (t) => {
  const tasks = Array.from({ length: 3000 }, (_x, i) => task(i + 1, i % 50 === 49 ? 'running' : i % 7 === 0 ? 'failed' : 'done'));
  const chat = Array.from({ length: 2000 }, (_x, i) => said(i));
  const V1 = v1(tasks, chat);
  seed({ state: V1 });
  const began = performance.now();
  store.load();
  const took = performance.now() - began;
  assert.equal(store.readOnly, null);
  assert.deepEqual(whole(), { ...JSON.parse(V1), version: 2 });
  const m = main();
  assert.equal(m.tasks.length, 60, 'only the tasks still at work');
  assert.equal(m.chat.length, SPLIT.tailMin);
  assert.deepEqual(m.sealed, { chat: 2000 - SPLIT.tailMin, tasks: 2940 });
  const size = fs.statSync(paths().state).size;
  assert.ok(size < V1.length / 20, `state.json is a fraction of what it was (${size} of ${V1.length})`);
  store.load();
  assert.deepEqual(whole(), { ...JSON.parse(V1), version: 2 });
  t.diagnostic(`3,000 tasks and 2,000 chat items: one file ${(V1.length / 1e6).toFixed(1)} MB, state.json after ${(size / 1e6).toFixed(2)} MB; split and checked in ${took.toFixed(0)} ms`);
});

test('store: files a first split left half done are set aside and the split starts again', () => {
  seed({ state: fixture('v1-history.json') });
  // The app stopped after it wrote the two files and before state.json: they hold records of a state that never was.
  writeLines(paths().tasksDone, [JSON.stringify(task(99))]);
  writeLines(paths().chatFile, [JSON.stringify(said(99))]);
  store.load();
  assert.equal(store.readOnly, null);
  assert.deepEqual(ids(store.data.tasks), ['T-0001', 'T-0002', 'T-0003', 'T-0004', 'T-0005']);
  assert.deepEqual(ids(doneFile().items), ['T-0001', 'T-0002', 'T-0004']);
  assert.deepEqual(chatFile().items, []);
  assert.equal(inData('tasks-done-before-v2-').length, 1);
  assert.equal(inData('chat-before-v2-').length, 1);
  assert.deepEqual(ids(foldLines<Task>(text(path.join(paths().data, inData('tasks-done-before-v2-')[0]))).items), ['T-0099'], 'kept, not thrown away');
});

test('store: a first split that does not read back leaves the version 1 file as it was, read-only', async () => {
  const V1 = fixture('v1-history.json');
  seed({ state: V1 });
  // The disk gives back less than was written to it.
  const readFile = fs.readFileSync;
  fs.readFileSync = ((file: fs.PathOrFileDescriptor, ...more: unknown[]) => {
    const out = (readFile as (...a: unknown[]) => string | Buffer)(file, ...more);
    return file === paths().tasksDone && typeof out === 'string' ? out.slice(0, out.indexOf('\n') + 1) : out;
  }) as typeof fs.readFileSync;
  try { store.load(); } finally { fs.readFileSync = readFile; }
  assert.deepEqual(store.readOnly, { why: 'failed', from: 1, error: 'the files written did not read back as the state' });
  assert.equal(text(paths().state), V1);
  assert.deepEqual([fs.existsSync(paths().tasksDone), fs.existsSync(paths().chatFile)], [false, false], 'the half-made files are gone');
  assert.equal(store.data.tasks.length, 5, 'the state is still there to look at');
  store.chat('event', 'after the failure');
  assert.equal(flushNow(), false);
  assert.equal(text(paths().state), V1);
  // The same when a file cannot be written at all.
  failing('chat.jsonl', () => store.load());
  assert.deepEqual(store.readOnly, { why: 'failed', from: 1, error: 'stopped before chat.jsonl' });
  assert.equal(text(paths().state), V1);
  assert.equal(fs.existsSync(paths().tasksDone), false);
  // And stopped right before state.json: the next start splits it, from the start.
  assert.throws(() => failing('state.json', () => { store.load(); if (store.readOnly) throw new Error(store.readOnly.why); }));
  assert.equal(text(paths().state), V1);
  store.load();
  assert.equal(store.readOnly, null);
  assert.deepEqual(whole(), { ...JSON.parse(V1), version: 2 });
  assert.deepEqual(ids(doneFile().items), ['T-0001', 'T-0002', 'T-0004']);
});

test('store: a save appends what left state.json and then writes it', () => {
  seed({ folder: 'v2' });
  store.load();
  assert.equal(store.migrated, null);
  assert.deepEqual(ids(store.data.tasks), ['T-0001', 'T-0002', 'T-0003', 'T-0004', 'T-0005']);
  assert.equal(store.task('T-0001')?.summary, 'Parser fixed', 'the last line written for it');
  assert.deepEqual(ids(store.data.chat), ['c1', 'c2', 'c3', 'c4', 'c5', 'c6']);
  const lines = () => text(paths().tasksDone).trim().split('\n').length;
  const before = lines();
  // A task that ended a while ago leaves; one that ended just now stays until it has settled.
  Object.assign(store.task('T-0003')!, { status: 'done', finishedAt: ago(HOUR), updatedAt: ago(HOUR) });
  Object.assign(store.task('T-0005')!, { status: 'cancelled', finishedAt: ago(1000), updatedAt: ago(1000) });
  assert.equal(flushNow(), true);
  assert.deepEqual(ids(main().tasks), ['T-0005']);
  assert.equal(lines(), before + 1);
  assert.equal(doneFile().items.at(-1)?.id, 'T-0003');
  assert.deepEqual(main().sealed, { chat: 4, tasks: 4 });
  // A task in the file that changes gets a new line, and is still one record.
  store.task('T-0002')!.summary = 'Failed on the build';
  flushNow();
  assert.equal(lines(), before + 2);
  assert.equal(doneFile().items.length, 4);
  // Chat leaves once the tail is long, down to the short tail.
  for (let i = 0; i < 120; i++) store.data.chat.push(said(100 + i));
  flushNow();
  assert.equal(main().chat.length, SPLIT.tailMin);
  assert.equal(chatFile().items.length, 4 + 2 + 120 - SPLIT.tailMin);
  assert.deepEqual(main().sealed, { chat: 76, tasks: 4 });
  // The next start has all of it, each once.
  const had = whole();
  store.load();
  assert.deepEqual(whole(), had);
  assert.equal(store.repaired.length + store.skippedLines, 0);
});

test('store: stopped between the appends and state.json, nothing is lost and nothing is there twice', () => {
  seed({ folder: 'v2' });
  store.load();
  Object.assign(store.task('T-0003')!, { status: 'done', finishedAt: ago(HOUR), updatedAt: ago(HOUR) });
  for (let i = 0; i < 120; i++) store.data.chat.push(said(100 + i));
  const all = whole();
  const old = text(paths().state);
  assert.throws(() => failing('state.json', () => store.flush()), /stopped before state.json/);
  assert.equal(text(paths().state), old, 'state.json is the one from before');
  assert.equal(doneFile().items.at(-1)?.id, 'T-0003', 'and the files already have what left');
  // The start after it: T-0003, c5 and c6 are in both and each is taken once, from the file. Only the newest
  // chat, which was on its way to state.json alone, went with the save that never finished.
  const had = { ...all, chat: all.chat.slice(0, all.chat.length - SPLIT.tailMin) };
  store.load();
  assert.deepEqual(whole(), had);
  assert.equal(store.task('T-0003')?.status, 'done');
  assert.equal(new Set(ids(store.data.chat)).size, store.data.chat.length);
  // The save after it appends nothing a second time.
  const files = [paths().tasksDone, paths().chatFile].map(text);
  assert.equal(flushNow(), true);
  assert.deepEqual([paths().tasksDone, paths().chatFile].map(text), files);
  assert.deepEqual(ids(main().tasks), ['T-0005']);
  store.load();
  assert.deepEqual(whole(), had);
});

test('store: a finished task that goes back to work is in state.json again', () => {
  seed({ folder: 'v2' });
  store.load();
  Object.assign(store.task('T-0001')!, { status: 'running', finishedAt: null });
  flushNow();
  assert.equal(text(paths().tasksDone).trim().split('\n').at(-1), '{"$open":"T-0001"}');
  assert.deepEqual(ids(main().tasks), ['T-0001', 'T-0003', 'T-0005']);
  store.load();
  assert.deepEqual(store.data.tasks.filter((t) => t.id === 'T-0001').map((t) => t.status), ['running']);
  // Stopped after the $open line and before state.json: the task is as it last ended, not gone.
  seed({ folder: 'v2' });
  store.load();
  Object.assign(store.task('T-0004')!, { status: 'running', finishedAt: null });
  assert.throws(() => failing('state.json', () => store.flush()));
  store.load();
  assert.deepEqual(store.data.tasks.filter((t) => t.id === 'T-0004').map((t) => t.status), ['cancelled']);
  // It ends again: a new record after the $open line.
  Object.assign(store.task('T-0004')!, { status: 'running', finishedAt: null });
  flushNow();
  Object.assign(store.task('T-0004')!, { status: 'done', finishedAt: ago(HOUR), updatedAt: ago(HOUR) });
  flushNow();
  store.load();
  assert.deepEqual(store.data.tasks.filter((t) => t.id === 'T-0004').map((t) => t.status), ['done']);
  assert.deepEqual(ids(main().tasks), ['T-0003', 'T-0005']);
});

test('store: a line cut off by a stop is skipped, and the next save starts on a new line', () => {
  seed({ folder: 'v2' });
  // The app died half way through appending c5 (which state.json therefore still has).
  fs.appendFileSync(paths().chatFile, '{"id":"c5","ts":"2026-11-01T09:05:00.000Z","kind":"err');
  store.load();
  assert.equal(store.skippedLines, 1);
  assert.deepEqual(store.repaired, [], 'no record is missing, so nothing is said');
  assert.deepEqual(ids(store.data.chat), ['c1', 'c2', 'c3', 'c4', 'c5', 'c6']);
  for (let i = 0; i < 120; i++) store.data.chat.push(said(100 + i));
  flushNow();
  const f = chatFile();
  assert.equal(f.bad, 1, 'the cut-off line alone');
  assert.deepEqual(ids(f.items).slice(0, 6), ['c1', 'c2', 'c3', 'c4', 'c5', 'c6']);
  const had = whole();
  store.load();
  assert.deepEqual(whole(), had);
});

test('store: appended lines start on a line of their own and a whole file replaces the old one', () => {
  const file = path.join(tmp, 'lines.jsonl');
  appendLines(file, []);
  assert.equal(fs.existsSync(file), false, 'nothing to add, nothing made');
  appendLines(file, ['{"id":"a"}']);
  appendLines(file, ['{"id":"b"}', '{"id":"c"}']);
  assert.equal(text(file), '{"id":"a"}\n{"id":"b"}\n{"id":"c"}\n');
  fs.appendFileSync(file, '{"id":"d');
  appendLines(file, ['{"id":"e"}']);
  assert.equal(text(file), '{"id":"a"}\n{"id":"b"}\n{"id":"c"}\n{"id":"d\n{"id":"e"}\n');
  writeLines(file, ['{"id":"z"}']);
  assert.equal(text(file), '{"id":"z"}\n');
  writeLines(file, []);
  assert.equal(text(file), '');
});

test('store: a file that lost records gets them back from the backups, and says what it could not find', () => {
  seed({ folder: 'v2-damaged' });
  const damaged = text(paths().chatFile);
  store.load();
  assert.equal(store.readOnly, null);
  assert.deepEqual(store.repaired, [
    { part: 'tasks', restored: 2, missing: 1, day: '2026-11-20' },
    { part: 'chat', restored: 2, missing: 1, day: '2026-11-20' },
  ]);
  assert.deepEqual(ids(store.data.tasks), ['T-0001', 'T-0002', 'T-0003', 'T-0005']);
  assert.equal(store.task('T-0001')?.summary, 'Parser fixed');
  assert.deepEqual(ids(store.data.chat), ['c1', 'c2', 'c3', 'c5', 'c6'], 'c4 was in no backup');
  // The damaged file is kept beside the one written anew; the one that was missing has nothing to keep.
  assert.equal(inData('chat-broken-').length, 1);
  assert.equal(text(path.join(paths().data, inData('chat-broken-')[0])), damaged);
  assert.equal(inData('tasks-done-broken-').length, 0);
  assert.deepEqual([chatFile().bad, ids(chatFile().items)], [0, ['c1', 'c2', 'c3']]);
  assert.deepEqual(main().sealed, { chat: 3, tasks: 2 }, 'state.json now counts what there is');
  // It is said once: the next start finds the files whole.
  store.load();
  assert.deepEqual(store.repaired, []);
  assert.deepEqual(ids(store.data.tasks), ['T-0001', 'T-0002', 'T-0003', 'T-0005']);
});

test('store: without state.json the two files still give what they hold', () => {
  seed({ folder: 'v2' });
  fs.rmSync(paths().state);
  store.load();
  assert.equal(store.readOnly, null);
  assert.equal(store.restoredFrom, null);
  assert.deepEqual(ids(store.data.tasks), ['T-0001', 'T-0002', 'T-0004']);
  assert.deepEqual(ids(store.data.chat), ['c1', 'c2', 'c3', 'c4']);
  assert.equal(store.data.counters.task, 4, 'the next task does not take an id in use');
  assert.equal(store.nextTaskId(), 'T-0005');
});

test('store: an unreadable state.json goes back to its backup and keeps what the files got since', () => {
  seed({ folder: 'v2' });
  // The backup is from before T-0004 and T-0005 were made, and before c3 and c4 left for the file.
  const older = { ...JSON.parse(fixture('v2/state.json')), counters: { worker: 1, task: 3 }, sealed: { chat: 2, tasks: 2 } };
  older.tasks = [older.tasks[0]];
  older.chat = [said(3), said(4)].map((c, i) => ({ ...c, id: `c${3 + i}` }));
  fs.mkdirSync(paths().backups, { recursive: true });
  fs.writeFileSync(path.join(paths().backups, 'state-2026-11-20.json'), JSON.stringify(older, null, 2));
  fs.writeFileSync(paths().state, '{ "version": 2, "tasks": [');
  store.load();
  assert.equal(store.restoredFrom, '2026-11-20');
  assert.equal(store.readOnly, null);
  assert.deepEqual(store.repaired, []);
  assert.deepEqual(ids(store.data.tasks), ['T-0001', 'T-0002', 'T-0003', 'T-0004'], 'T-0004 ended after the backup and is in the file');
  assert.deepEqual(ids(store.data.chat), ['c1', 'c2', 'c3', 'c4'], 'chat in both is taken once');
  assert.equal(store.data.counters.task, 4);
  assert.equal(inData('state-broken-').length, 1);
  assert.equal(main().version, 2);
});

test('store: a version 1 backup put back beside newer files takes their records with it', () => {
  seed({ folder: 'v2' });
  appendLines(paths().tasksDone, [JSON.stringify(task(9))]);
  fs.mkdirSync(paths().backups, { recursive: true });
  fs.writeFileSync(path.join(paths().backups, 'state-2026-11-19.json'), fixture('v1-history.json'));
  fs.writeFileSync(paths().state, 'not a state');
  store.load();
  assert.equal(store.restoredFrom, '2026-11-19');
  assert.equal(store.migrated?.from, 1);
  assert.equal(store.readOnly, null);
  assert.deepEqual(ids(store.data.tasks), ['T-0001', 'T-0002', 'T-0003', 'T-0004', 'T-0005', 'T-0009']);
  assert.deepEqual(ids(store.data.chat), ['c1', 'c2', 'c3', 'c4', 'c5', 'c6']);
  assert.equal(store.data.counters.task, 9);
  assert.deepEqual(ids(doneFile().items), ['T-0001', 'T-0002', 'T-0004', 'T-0009']);
  const had = whole();
  store.load();
  assert.deepEqual(whole(), had);
});

test('store: a state from a newer build is read with its files and nothing is touched', () => {
  seed({ folder: 'v2-damaged' });
  fs.writeFileSync(paths().state, JSON.stringify({ ...JSON.parse(fixture('v2/state.json')), version: 3 }, null, 2));
  const names = fs.readdirSync(paths().data).sort();
  const chat = text(paths().chatFile);
  store.load();
  assert.deepEqual(store.readOnly, { why: 'newer', version: 3 });
  assert.deepEqual(store.repaired, [], 'not this build\'s files to put right');
  assert.deepEqual(ids(store.data.chat), ['c1', 'c5', 'c6']);
  assert.equal(flushNow(), false);
  assert.deepEqual(fs.readdirSync(paths().data).sort(), names);
  assert.equal(text(paths().chatFile), chat);
});

test('store: a version 1 state whose lists are not lists is left alone, read-only', () => {
  const bad = JSON.stringify({ version: 1, counters: { worker: 0, task: 0 }, tasks: { 'T-0001': {} }, chat: [] });
  seed({ state: bad });
  store.load();
  assert.deepEqual(store.readOnly, { why: 'failed', from: 1, error: '"tasks" is not a list' });
  assert.equal(text(paths().state), bad);
  assert.deepEqual([fs.existsSync(paths().tasksDone), fs.existsSync(paths().chatFile)], [false, false]);
  seed({ state: JSON.stringify({ version: 1, tasks: [], chat: ['hello'] }) });
  store.load();
  assert.deepEqual(store.readOnly, { why: 'failed', from: 1, error: '"chat" holds something that is not a record' });
});

test('store: records without an id of their own stay in state.json and none is lost', () => {
  seed({ state: fixture('v1-odd.json') });
  store.load();
  assert.equal(store.readOnly, null);
  assert.deepEqual(store.data.tasks.map((t) => `${t.id ?? '-'} ${t.title}`), ['T-0001 Task 1', 'T-0001 Task 1 again', 'T-0002 Task 2', 'T-0003 Task 3', '- Task 4']);
  assert.deepEqual(ids(doneFile().items), ['T-0003'], 'the one finished task whose id is its own');
  assert.equal(main().tasks.length, 4);
  // Chat items get an id where they had none or shared one, so each can be told apart later.
  assert.deepEqual(store.data.chat.map((c) => `${c.id} ${c.text}`), ['c1 message 1', 'old-1 message 2', 'old-2 message 1 again', 'c3 message 3', 'old-4 message 4']);
  const had = whole();
  store.load();
  assert.deepEqual(whole(), had);
});

test('store: the way back writes one version 1 file with everything, and the next start splits it again', () => {
  const V1 = v1([task(1), task(2, 'running'), task(3, 'failed'), task(4)], Array.from({ length: 300 }, (_x, i) => said(i)));
  seed({ state: V1 });
  assert.deepEqual(rollbackToV1(paths()), { kind: 'none', why: 'v1' });
  store.load();
  const split = [paths().state, paths().chatFile, paths().tasksDone].map(text);
  assert.equal(main().chat.length, SPLIT.tailMin);
  const r = rollbackToV1(paths(), 42);
  assert.deepEqual(r, {
    kind: 'done', tasks: 4, chat: 300,
    kept: ['state-v2-before-v1-42.json', 'chat-before-v1-42.jsonl', 'tasks-done-before-v1-42.jsonl'].map((n) => path.join(paths().data, n)),
  });
  assert.equal(text(paths().state), V1, 'byte for byte the file the older build wrote');
  assert.deepEqual([fs.existsSync(paths().tasksDone), fs.existsSync(paths().chatFile)], [false, false]);
  assert.deepEqual((r.kind === 'done' ? r.kept : []).map(text), split, 'what it was put together from is kept');
  assert.deepEqual(rollbackToV1(paths()), { kind: 'none', why: 'v1' }, 'a second time there is nothing to do');
  // A newer build started on it again splits it the same way.
  store.load();
  assert.equal(store.migrated?.from, 1);
  assert.deepEqual([paths().state, paths().chatFile, paths().tasksDone].map(text), split);
});

test('store: the way back is not taken from a state it cannot read or does not know', () => {
  seed({ state: '{ not json' });
  assert.deepEqual(rollbackToV1(paths()), { kind: 'none', why: 'broken' });
  assert.equal(text(paths().state), '{ not json');
  fs.rmSync(paths().state);
  assert.deepEqual(rollbackToV1(paths()), { kind: 'none', why: 'missing' });
  seed({ state: fixture('v3-newer.json') });
  assert.deepEqual(rollbackToV1(paths()), { kind: 'none', why: 'newer', version: 3 });
  assert.equal(text(paths().state), fixture('v3-newer.json'));
  // After work in the split layout, with a task reopened and one still unsettled, everything is in the one file.
  seed({ folder: 'v2' });
  store.load();
  Object.assign(store.task('T-0001')!, { status: 'running', finishedAt: null });
  flushNow();
  const had = whole();
  assert.equal(rollbackToV1(paths()).kind, 'done');
  assert.deepEqual(JSON.parse(text(paths().state)), { ...had, version: 1 });
});

test('store: chat older than memory holds is read from the file, for a page and for a search', async () => {
  const chat = Array.from({ length: 2000 }, (_x, i) => said(i, i === 10 ? 'where the zebra crossing was' : `message ${i}`));
  seed({ state: v1([], chat) });
  store.load();
  for (let i = 2000; i < 2300; i++) store.data.chat.push(said(i));
  flushNow();
  assert.equal(store.data.chat.length, SPLIT.chatKeep, 'memory keeps the newest');
  assert.equal(store.data.chat[0].id, 'c300');
  assert.equal(chatFile().items.length, 2300 - SPLIT.tailMin, 'and the file has what left it');
  // A page inside memory, one that starts in memory and ends in the file, and the oldest one.
  const inside = await store.chatPage('c900', 50);
  assert.deepEqual([inside.items[0].id, inside.items.at(-1)?.id, inside.more], ['c850', 'c899', true]);
  const across = await store.chatPage('c320', 50);
  assert.deepEqual([across.items.length, across.items[0].id, across.items.at(-1)?.id, across.more], [50, 'c270', 'c319', true]);
  const edge = await store.chatPage('c300', 50);
  assert.deepEqual([edge.items[0].id, edge.items.at(-1)?.id, edge.more], ['c250', 'c299', true]);
  const oldest = await store.chatPage('c40', 50);
  assert.deepEqual([oldest.items.length, oldest.items[0].id, oldest.more], [40, 'c0', false]);
  const full = await store.chatPage('c350', 50);
  assert.deepEqual([full.items[0].id, full.more], ['c300', true], 'memory ends there, the chat does not');
  // Search goes on into the file when memory has too few hits.
  assert.deepEqual((await store.searchText('zebra crossing')).map((h) => [h.where, h.id]), [['chat', 'c10']]);
  // The same after a restart.
  store.load();
  assert.equal(store.data.chat.length, SPLIT.chatKeep);
  assert.equal(store.data.chat[0].id, 'c300');
  assert.deepEqual(ids((await store.chatPage('c300', 3)).items), ['c297', 'c298', 'c299']);
  assert.equal(ids(main().chat).at(-1), 'c2299');
});

test('store: a day\'s backup is the three files, and each keeps a week of them', () => {
  seed({ folder: 'v2' });
  store.load();
  fs.mkdirSync(paths().backups, { recursive: true });
  for (let d = 10; d < 18; d++) for (const n of [`state-2026-11-${d}.json`, `chat-2026-11-${d}.jsonl`, `tasks-done-2026-11-${d}.jsonl`]) fs.writeFileSync(path.join(paths().backups, n), '{}');
  store.backup(new Date(2026, 10, 26));
  const names = fs.readdirSync(paths().backups).sort();
  assert.equal(names.length, 21);
  assert.deepEqual(names.filter((n) => n.includes('2026-11-26')), ['chat-2026-11-26.jsonl', 'state-2026-11-26.json', 'tasks-done-2026-11-26.jsonl']);
  assert.deepEqual(names.filter((n) => /2026-11-1[01]/.test(n)), [], 'the two oldest days went');
  assert.equal(text(path.join(paths().backups, 'chat-2026-11-26.jsonl')), text(paths().chatFile));
  assert.equal(text(path.join(paths().backups, 'tasks-done-2026-11-26.jsonl')), text(paths().tasksDone));
  // The day's copies are made once: a later hour of the same day leaves them.
  appendLines(paths().chatFile, [JSON.stringify(said(50))]);
  store.backup(new Date(2026, 10, 26, 13));
  assert.notEqual(text(path.join(paths().backups, 'chat-2026-11-26.jsonl')), text(paths().chatFile));
});
