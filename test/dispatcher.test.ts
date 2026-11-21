import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dispatcher, readWorker } from '../src/main/agents/dispatcher';
import { AgentSession } from '../src/main/agents/session';
import { store } from '../src/main/store';
import { loadSettings } from '../src/main/settings';
import type { Worker } from '../src/shared/types';

// Settings and the IDE home live in a temp folder. Nothing here reads them until a test runs.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-dispatcher-'));
process.env.OMA_DATA_DIR = tmp;
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({
  home: path.join(tmp, 'home'), language: 'en', claudeRules: false, claudeMemory: false, selfReview: false,
  accounts: [{ id: 'acc', label: 'Test', kind: 'login', plan: 'team' }],
}));

/** What the Dispatcher's session was sent, in order. No Claude Code process is started. */
let sent: string[] = [];
AgentSession.prototype.send = function (text: string) {
  sent.push(text);
  this.busy = true;
  this.ev.onStatus?.('busy', '');
};

const AUTO = '[Automatic turn] No message from the user: the Worker updates above started this turn. Judge them, tell the user only what they should know, and act only where needed. If there is nothing to say or do, reply with exactly NOOP.';
const WAIT_MS = 5;
/** Longer than the wait in which Worker news is gathered. */
const settled = () => new Promise((r) => setTimeout(r, WAIT_MS * 8));
const limit = (on: boolean) => { loadSettings().accounts[0].limitedUntil = on ? new Date(Date.now() + 3600_000).toISOString() : null; };
/** The Dispatcher's turn says this and ends. */
function turn(text: string) {
  const s = dispatcher.session as unknown as { handle(m: unknown): void };
  s.handle({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text }] } });
  s.handle({ type: 'result', subtype: 'success', is_error: false, result: text });
}
/** Worker news worth a Dispatcher turn. */
const news = (text: string) => store.pushUpdate(text, true);
const said = () => store.data.chat.filter((c) => c.kind === 'dispatcher').map((c) => c.text);
const events = () => store.data.chat.filter((c) => c.kind === 'event').map((c) => c.text);

// As the app wires it.
store.on('wake', () => dispatcher.wake());

beforeEach(() => {
  dispatcher.close();
  dispatcher.wakeDelay = WAIT_MS;
  const d = dispatcher as unknown as { held: string[]; cutOff: boolean; wakeDue: boolean; userSpoke(): void };
  d.held = [];
  d.cutOff = false;
  d.wakeDue = false;
  d.userSpoke();
  Object.assign(store.data, { workers: [], tasks: [], chat: [], pendingUpdates: [], dispatcher: { sessionId: null, date: null, contextTokens: 0, accountId: null } });
  sent = [];
  limit(false);
});

test('Worker news worth a turn starts one by itself, several items together; other news waits for the next message', async () => {
  store.pushUpdate('W-1 (T-1) notes: half way.');
  await settled();
  assert.deepEqual(sent, [], 'a note starts no turn');

  news('W-1 answered your question "Which file?": src/parse.ts');
  news('W-2 T-2 "Task" done: Done');
  assert.deepEqual(sent, [], 'not before the news has settled');
  await settled();
  assert.deepEqual(sent, [
    `[Worker updates]\n- W-1 (T-1) notes: half way.\n- W-1 answered your question "Which file?": src/parse.ts\n- W-2 T-2 "Task" done: Done\n\n${AUTO}`,
  ]);
  assert.deepEqual(store.data.pendingUpdates, []);
});

test('news that comes while the Dispatcher is in a turn gets its own turn when that one ends', async () => {
  dispatcher.send('Hello');
  news('W-1 T-1 "Task" failed: It broke.');
  await settled();
  assert.deepEqual(sent, ['Hello']);
  turn('Hi.');
  await settled();
  assert.equal(sent.length, 2);
  assert.equal(sent[1], `[Worker updates]\n- W-1 T-1 "Task" failed: It broke.\n\n${AUTO}`);
});

test("a message from the user takes the waiting news along, so no turn starts for it afterwards", async () => {
  news('W-1 T-1 "Task" done: Done');
  dispatcher.send('What is going on?');
  assert.deepEqual(sent, ['[Worker updates]\n- W-1 T-1 "Task" done: Done\n\nWhat is going on?']);
  turn('T-1 is done.');
  await settled();
  assert.equal(sent.length, 1);
});

test('an automatic turn with nothing to say answers NOOP, which the chat does not show', async () => {
  news('W-1 T-1 "Task" done: Done');
  await settled();
  turn('NOOP');
  assert.deepEqual(said(), []);

  news('W-1 answered your question "Which file?": src/parse.ts');
  await settled();
  turn('The parser is in src/parse.ts, W-1 says.');
  assert.deepEqual(said(), ['The parser is in src/parse.ts, W-1 says.']);

  // What the Dispatcher answers the user is always shown.
  dispatcher.send('Reply with NOOP.');
  turn('NOOP');
  assert.deepEqual(said(), ['The parser is in src/parse.ts, W-1 says.', 'NOOP']);
});

test('acting on Worker news by itself stops after 8 turns in a row; the next message from the user starts it over', async () => {
  for (let i = 1; i <= 8; i++) {
    news(`news ${i}`);
    await settled();
    assert.equal(sent.length, i);
    dispatcher.acted();
    turn('Created the next task.');
  }
  news('news 9');
  news('news 10');
  await settled();
  assert.equal(sent.length, 8);
  assert.deepEqual(events(), ['The Dispatcher acted on Worker news 8 times in a row and stopped following up by itself. Send a message to continue.']);
  assert.deepEqual(store.data.pendingUpdates, ['news 9', 'news 10'], 'kept for the next message');

  dispatcher.send('Go on.');
  assert.equal(sent[8], '[Worker updates]\n- news 9\n- news 10\n\nGo on.');
  turn('Going on.');
  news('news 11');
  await settled();
  assert.equal(sent.length, 10);
});

test('automatic turns that only report do not count towards that limit', async () => {
  for (let i = 1; i <= 10; i++) {
    news(`news ${i}`);
    await settled();
    turn(i % 2 ? 'NOOP' : 'T-1 is done.');
  }
  assert.equal(sent.length, 10);
  assert.deepEqual(events(), []);
});

test('in automatic turns the Dispatcher writes to one Worker three times at most, until the user speaks', async () => {
  dispatcher.send('Ask W-1 as often as you like.');
  for (let i = 0; i < 5; i++) assert.equal(dispatcher.mayWrite('W-1'), null, "the user's own turn has no such limit");
  turn('Asked.');

  for (let i = 1; i <= 3; i++) {
    news(`W-1 answered your question "Q${i}": A${i}`);
    await settled();
    assert.equal(dispatcher.mayWrite('W-1'), null);
    turn('Asked again.');
  }
  news('W-1 answered your question "Q4": A4');
  await settled();
  assert.match(dispatcher.mayWrite('W-1') ?? '', /^Not sent: you have written to W-1 3 times since the user last spoke/);
  assert.equal(dispatcher.mayWrite('W-2'), null, 'another Worker has its own count');
  turn('W-1 and I went back and forth three times; here is where it stands.');

  dispatcher.send('Ask once more.');
  turn('Asked.');
  news('W-1 answered your question "Q5": A5');
  await settled();
  assert.equal(dispatcher.mayWrite('W-1'), null);
});

test('while a usage limit holds every account, the news waits and starts its turn when the limit resets', async () => {
  limit(true);
  news('W-1 T-1 "Task" done: Done');
  await settled();
  assert.deepEqual(sent, []);
  assert.equal(store.data.pendingUpdates.length, 1);
  limit(false);
  dispatcher.retryHeld();
  assert.deepEqual(sent, [`[Worker updates]\n- W-1 T-1 "Task" done: Done\n\n${AUTO}`]);
});

test("read_worker shows what a Worker is doing, what is unanswered, and the latest of its conversation, long messages cut", () => {
  const at = new Date();
  const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  const w: Worker = {
    id: 'W-7', title: 'Worker', model: 'claude-opus-5-5', accountId: null, sessionId: 'sid', cwd: tmp, repo: 'app',
    status: 'idle', statusText: 'Waiting for the Dispatcher', contextTokens: 120_400, taskIds: [], createdAt: at.toISOString(), lastActiveAt: at.toISOString(), knowledge: '',
    ask: { text: 'Which file holds the parser?', at: at.toISOString() },
    request: { text: 'I need the bucket name.', at: at.toISOString() },
  };
  store.data.workers.push(w);
  assert.equal(readWorker('W-0'), null);
  assert.match(readWorker(w.id)!, /\(latest 0 of 0 messages, oldest first\)\n\(empty\)$/);

  store.log(w.id, 'dispatcher', '[Task T-1] Do it.');
  store.log(w.id, 'worker', 'Looking at the parser.');
  store.log(w.id, 'worker', `RESULT: Done\n${'x'.repeat(2000)}`);
  const view = readWorker(w.id, 2)!;
  assert.ok(view.startsWith('- W-7 [idle] app, '), view);
  assert.ok(view.includes('context 120K\n  Now: Waiting for the Dispatcher\n  Tasks: none'), view);
  assert.ok(view.includes(`\n  Has not answered your question yet (asked ${hhmm}): Which file holds the parser?`), view);
  assert.ok(view.includes(`\n  Waits for your answer (since ${hhmm}): I need the bucket name.`), view);
  assert.ok(view.includes('Conversation (latest 2 of 3 messages, oldest first)\n'), view);
  assert.ok(!view.includes('[Task T-1]'), 'only the latest two');
  assert.ok(view.includes(`[${hhmm} worker] Looking at the parser.\n\n[${hhmm} worker] RESULT: Done\n`), view);
  assert.ok(view.endsWith('… (513 more characters cut)'), view.slice(-60));
});
