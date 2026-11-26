// End-to-end flows: Where the saved state lives: state.json with what is live, and chat and finished tasks in the two
// files beside it (chat.jsonl, tasks-done.jsonl); the first start on a state saved as one file, and the way back.
// Each flow starts the built app on its own profile with fake agents and a stand-in for gh. Run with `npm run e2e`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { flow } from './harness.mjs';

const task = (n) => ({
  id: `T-${String(n).padStart(4, '0')}`, title: `Old task ${n}`, prompt: '', kind: 'other', repo: null, workerId: null, status: 'done', branch: null, prUrl: null,
  prState: null, summary: `Did ${n}.`, files: [], createdAt: '2026-10-01T09:00:00.000Z', updatedAt: '2026-10-01T10:00:00.000Z', finishedAt: '2026-10-01T10:00:00.000Z',
  reviewSyncedAt: null, seenCommentIds: [],
});
const said = (n, text = `message ${n}`) => ({ id: `c${n}`, ts: new Date(Date.UTC(2026, 9, 1) + n * 1000).toISOString(), kind: n % 2 ? 'dispatcher' : 'user', text });
/** A state as a build before the split saved it: everything in the one file. */
const oneFile = (tasks, chat) => JSON.stringify({ version: 1, counters: { worker: 0, task: tasks }, tasks: Array.from({ length: tasks }, (_x, i) => task(i + 1)), chat }, null, 2);

const inData = (app, name) => path.join(app.home, 'data', name);
const saved = (app) => JSON.parse(fs.readFileSync(inData(app, 'state.json'), 'utf8'));
const lines = (app, name) => fs.readFileSync(inData(app, name), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const named = (app, start) => fs.readdirSync(path.join(app.home, 'data')).filter((n) => n.startsWith(start));

// More chat than the app holds in memory, with one old message to look for.
const LONG = oneFile(40, Array.from({ length: 2100 }, (_x, i) => said(i, i === 7 ? 'The lighthouse rule: lamps on at dusk.' : `message ${i}`)));

flow('a state saved as one file is split at the first start, and the lists, the chat and the search still have all of it', {
  files: { 'data/state.json': LONG },
}, async (app) => {
  let s = await app.state();
  assert.equal(s.tasks.length, 40);
  assert.deepEqual([s.tasks[0].title, s.tasks.at(-1).title], ['Old task 1', 'Old task 40']);
  assert.equal(s.chat.at(-1).text, 'message 2099');
  assert.equal(s.chat.some((c) => c.kind === 'error'), false, 'nothing went wrong, so nothing is said');
  // On disk: the file as it was is kept; state.json holds what is live; the rest is in the two files.
  assert.equal(named(app, 'state-v1-before-v2-').length, 1);
  assert.equal(fs.readFileSync(inData(app, named(app, 'state-v1-before-v2-')[0]), 'utf8'), LONG);
  const main = saved(app);
  assert.deepEqual([main.version, main.tasks.length, main.chat.length, main.sealed], [2, 0, 50, { chat: 2050, tasks: 40 }]);
  assert.equal(lines(app, 'tasks-done.jsonl').length, 40);
  assert.equal(lines(app, 'chat.jsonl').length, 2050);
  assert.ok(fs.statSync(inData(app, 'state.json')).size < LONG.length / 10, 'state.json is a fraction of what it was');
  // A page of chat older than memory holds comes from the file.
  const page = await app.evaluate(`return await window.ide.call('chat:page', 'c100', 100);`);
  assert.deepEqual([page.items.length, page.items[0].id, page.items.at(-1).id, page.more], [100, 'c0', 'c99', false]);
  // The palette finds a message that old, and the chat goes back to it.
  await app.click('#cmdk-btn');
  await app.evaluate("const q = document.querySelector('#cmdk-q'); q.value = 'lighthouse rule'; q.dispatchEvent(new Event('input', { bubbles: true })); return 1;");
  await app.until("const el = [...document.querySelectorAll('.cmdk-it')].find((x) => x.innerText.includes('lamps on at dusk')); el?.click(); return !!el;", 'the old message among the results', 20_000);
  await app.until("document.querySelector('#chat-thread')?.innerText.includes('lamps on at dusk')", 'the chat going back to the old message', 20_000);
  // New work takes the next id, and a restart finds everything again.
  await app.say('@fake task - New after the split\n@@fake result Done after the split.');
  await app.until(`const s = await window.ide.call('state'); return s.tasks.some((t) => t.id === 'T-0041' && t.status === 'done');`, 'the new task finished as T-0041');
  await app.until(`return (await window.ide.call('state')).chat.some((c) => c.kind === 'result' && c.text.includes('Done after the split.'));`, 'its result in the chat');
  // What the app finds after a restart is what it saved: wait for the new task on disk.
  for (const end = Date.now() + 20_000; !saved(app).tasks.some((t) => t.id === 'T-0041' && t.status === 'done');) {
    if (Date.now() > end) throw new Error('The new task was never saved.');
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(saved(app).tasks.length, 1, 'a task that just ended stays in state.json for now');
  await app.restart();
  s = await app.state();
  assert.equal(s.tasks.length, 41);
  assert.deepEqual([s.tasks[0].title, s.tasks.at(-1).title], ['Old task 1', 'New after the split']);
  assert.ok(s.chat.some((c) => c.text === 'message 2099') && s.chat.some((c) => c.text.includes('Done after the split.')));
  assert.equal(s.chat.some((c) => c.kind === 'error'), false);
  const again = await app.evaluate(`return await window.ide.call('chat:page', 'c8', 100);`);
  assert.deepEqual(again.items.map((c) => c.id), ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7']);
  assert.equal(named(app, 'state-v1-before-v2-').length, 1, 'no second migration');
});

const SHORT = oneFile(5, Array.from({ length: 150 }, (_x, i) => said(i)));

flow('started with --state-v1 the app writes the state back as one file and quits; the next start splits it again', {
  files: { 'data/state.json': SHORT },
}, async (app) => {
  assert.deepEqual([saved(app).version, lines(app, 'chat.jsonl').length, lines(app, 'tasks-done.jsonl').length], [2, 100, 5]);
  // Beside a running app nothing is done: the app that runs would write over it.
  await app.once(['--state-v1'], { beside: true });
  assert.equal(saved(app).version, 2);
  assert.deepEqual(named(app, 'state-v2-before-v1-'), []);
  // With the app closed, one file holds everything again and the files it came from are kept.
  assert.equal(await app.once(['--state-v1']), 0);
  const back = saved(app);
  assert.deepEqual([back.version, 'sealed' in back], [1, false]);
  assert.deepEqual(back.tasks, JSON.parse(SHORT).tasks);
  assert.deepEqual(back.chat, JSON.parse(SHORT).chat);
  assert.deepEqual([fs.existsSync(inData(app, 'chat.jsonl')), fs.existsSync(inData(app, 'tasks-done.jsonl'))], [false, false]);
  assert.deepEqual([named(app, 'state-v2-before-v1-').length, named(app, 'chat-before-v1-').length, named(app, 'tasks-done-before-v1-').length], [1, 1, 1]);
  // A second time there is nothing to write back, and nothing is touched.
  assert.equal(await app.once(['--state-v1']), 0);
  assert.equal(named(app, 'state-v2-before-v1-').length, 1);
  // The app opened on it again splits it as at the first start.
  await app.restart();
  const s = await app.state();
  assert.deepEqual([s.tasks.length, s.chat.filter((c) => /^message \d+$/.test(c.text)).length], [5, 150]);
  assert.equal(s.chat.some((c) => c.kind === 'error'), false);
  assert.deepEqual([saved(app).version, lines(app, 'tasks-done.jsonl').length], [2, 5]);
  assert.equal(named(app, 'state-v1-before-v2-').length, 2);
});

// state.json counts three messages and two tasks in the files; chat.jsonl holds one and a cut-off line, and
// tasks-done.jsonl is gone. A backup still has one of the messages and both tasks.
const COUNTED = JSON.stringify({ version: 2, counters: { worker: 0, task: 2 }, tasks: [], chat: [said(3)], sealed: { chat: 3, tasks: 2 } }, null, 2);
const row = (x) => `${JSON.stringify(x)}\n`;

flow('a file beside state.json that lost records gets them back from a backup, and the chat says what it could not find', {
  files: {
    'data/state.json': COUNTED,
    'data/chat.jsonl': `${row(said(0))}{"id":"c1","ts":"2026-10-01T00:00:01.0`,
    'data/backups/chat-2026-11-20.jsonl': row(said(0)) + row(said(1)),
    'data/backups/tasks-done-2026-11-20.jsonl': row(task(1)) + row(task(2)),
  },
}, async (app) => {
  const s = await app.state();
  assert.deepEqual(s.tasks.map((t) => t.title), ['Old task 1', 'Old task 2']);
  assert.deepEqual(s.chat.filter((c) => /^message \d+$/.test(c.text)).map((c) => c.id), ['c0', 'c1', 'c3']);
  const told = s.chat.filter((c) => c.kind === 'error').map((c) => c.text);
  assert.deepEqual(told, [
    'Tasks missing from the file that keeps finished tasks (tasks-done.jsonl): 2. Put back from backups: 2; not found: 0.',
    'Messages missing from the file that keeps older chat (chat.jsonl): 2. Put back from backups: 1; not found: 1.',
  ]);
  assert.match(await app.evaluate("document.querySelector('#chat-thread').innerText"), /Put back from backups: 1; not found: 1\./);
  // The files are whole again, the damaged one is kept beside them, and state.json counts what there is.
  assert.deepEqual(lines(app, 'chat.jsonl').map((c) => c.id), ['c0', 'c1']);
  assert.deepEqual(lines(app, 'tasks-done.jsonl').map((t) => t.id), ['T-0001', 'T-0002']);
  assert.equal(named(app, 'chat-broken-').length, 1);
  assert.deepEqual(saved(app).sealed, { chat: 2, tasks: 2 });
  // It is said once. What the app finds after a restart is what it saved: wait for the two notices on disk.
  for (const end = Date.now() + 20_000; saved(app).chat.filter((c) => c.kind === 'error').length < 2;) {
    if (Date.now() > end) throw new Error('The notices were never saved.');
    await new Promise((r) => setTimeout(r, 100));
  }
  await app.restart();
  assert.equal((await app.state()).chat.filter((c) => c.kind === 'error').length, 2);
});
