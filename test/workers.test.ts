import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { workers } from '../src/main/agents/workers';
import { AgentSession } from '../src/main/agents/session';
import { store } from '../src/main/store';
import { loadSettings } from '../src/main/settings';
import type { Task, Worker } from '../src/shared/types';

// Settings and the IDE home live in a temp folder. Nothing here reads them until a test runs.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-workers-'));
process.env.OMA_DATA_DIR = tmp;
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({
  home: path.join(tmp, 'home'), language: 'en', claudeRules: false, claudeMemory: false, selfReview: false,
  accounts: [{ id: 'acc', label: 'Test', kind: 'login', plan: 'team' }],
}));

/** What each Worker's session was sent, in order. No Claude Code process is started. */
const sent = new Map<string, string[]>();
AgentSession.prototype.send = function (text: string) {
  sent.set(this.cfg.label, [...(sent.get(this.cfg.label) ?? []), text]);
  this.busy = true;
  this.ev.onStatus?.('busy', '');
};
AgentSession.prototype.setMode = async function (mode) { this.cfg.permissionMode = mode; };

/** Every account is held by a usage limit (true), or free again (false). */
const limit = (on: boolean) => { loadSettings().accounts[0].limitedUntil = on ? new Date(Date.now() + 3600_000).toISOString() : null; };
const tick = () => new Promise((r) => setImmediate(r));
const now = new Date().toISOString();
let n = 0;

function addWorker(over: Partial<Worker> = {}): Worker {
  const w: Worker = {
    id: `W-${++n}`, title: 'Worker', model: 'claude-opus-5-5', accountId: null, sessionId: null, cwd: tmp, repo: null,
    status: 'idle', statusText: '', contextTokens: 0, taskIds: [], createdAt: now, lastActiveAt: now, knowledge: '', ...over,
  };
  store.data.workers.push(w);
  return w;
}

/** A task in the store; with a Worker, already assigned to it. */
function addTask(w: Worker | null, over: Partial<Task> = {}): Task {
  const x: Task = {
    id: `T-${++n}`, title: 'Task', prompt: 'Do it.', kind: 'other', repo: null, workerId: w?.id ?? null, status: 'running',
    branch: null, prUrl: null, prState: null, summary: null, files: [], createdAt: now, updatedAt: now, startedAt: now,
    finishedAt: null, reviewSyncedAt: null, seenCommentIds: [], ...over,
  };
  store.data.tasks.push(x);
  w?.taskIds.push(x.id);
  return x;
}

/** A Worker on a started task that every account's usage limit then paused, as onLimited leaves it. */
function pausedWorker() {
  const w = addWorker({ sessionId: 'sid' });
  const x = addTask(w);
  const s = workers.ensureSession(w)!;
  limit(true);
  s.ev.onLimited!();
  return { w, x };
}

beforeEach(() => {
  workers.closeAll();
  (workers as unknown as { held: Map<string, string[]> }).held.clear();
  Object.assign(store.data, { workers: [], tasks: [], chat: [], pendingUpdates: [] });
  sent.clear();
  limit(false);
});

test('a usage limit pauses the task: the Worker is idle and the task waits in the queue', () => {
  const { w, x } = pausedWorker();
  assert.equal(x.status, 'queued');
  assert.equal(w.status, 'idle');
  assert.match(w.statusText, /limit/i);
});

test('send_to_worker on a paused task runs the task again, and the periodic retry does not nudge it twice', () => {
  const { w, x } = pausedWorker();
  limit(false);
  workers.send(w.id, 'dispatcher', 'Continue now.');
  assert.equal(w.status, 'running');
  assert.equal(x.status, 'running');
  assert.equal(w.statusText, '');
  workers.retryQueued();
  assert.deepEqual(sent.get(w.id), ['[Dispatcher] Continue now.']);
});

test('when the limit resets, the paused task runs again and the Worker is told to continue', () => {
  const { w, x } = pausedWorker();
  limit(false);
  workers.retryQueued();
  assert.equal(x.status, 'running');
  assert.equal(w.status, 'running');
  assert.equal(sent.get(w.id)?.length, 1);
  assert.match(sent.get(w.id)![0], /usage limit has reset/);
});

test('a message held during the limit pauses the running task and goes out before the next one', () => {
  const w = addWorker({ sessionId: 'sid' });
  const x = addTask(w);
  limit(true);
  workers.send(w.id, 'user', 'First.');
  assert.equal(x.status, 'queued');
  assert.equal(sent.get(w.id), undefined);
  limit(false);
  workers.send(w.id, 'dispatcher', 'Second.');
  assert.equal(x.status, 'running');
  assert.deepEqual(sent.get(w.id), ['[User message] First.', '[Dispatcher] Second.']);
});

test('a task assigned while every account was limited starts with its task message, even on a Worker with a session', async () => {
  const w = addWorker({ sessionId: 'from-an-earlier-task' });
  addTask(w, { status: 'done', finishedAt: now });
  const x = addTask(null, { status: 'queued', startedAt: null });
  limit(true);
  await workers.assign(x, w.id, w.model);
  assert.equal(x.status, 'queued');
  assert.equal(x.startedAt, null);
  limit(false);
  workers.send(w.id, 'dispatcher', 'Start it now.');
  await tick();
  assert.equal(x.status, 'running');
  assert.ok(x.startedAt);
  const msgs = sent.get(w.id)!;
  assert.equal(msgs.length, 2);
  assert.ok(msgs[0].startsWith(`[Task ${x.id}]`), msgs[0]);
  assert.equal(msgs[1], '[Dispatcher] Start it now.');
});

test('a session that dies mid-task fails the task with it; told to continue, the Worker picks it up again', () => {
  const w = addWorker({ sessionId: 'sid' });
  const x = addTask(w);
  workers.ensureSession(w)!.ev.onStatus!('error', 'Claude Code native binary failed to launch');
  assert.equal(w.status, 'error');
  assert.equal(x.status, 'failed');
  assert.match(x.summary!, /failed to launch/);
  assert.equal(store.data.chat.filter((c) => c.kind === 'error' && c.ref === x.id).length, 1);
  workers.send(w.id, 'dispatcher', 'Try again.');
  assert.equal(w.status, 'running');
  assert.equal(x.status, 'running');
});

test('a session error leaves a task the limit paused in the queue', () => {
  const { w, x } = pausedWorker();
  workers.sessions.get(w.id)!.ev.onStatus!('error', 'Something went wrong');
  assert.equal(w.status, 'error');
  assert.equal(x.status, 'queued');
});

test('a turn that ends in an error fails its task once', () => {
  const w = addWorker({ sessionId: 'sid' });
  const x = addTask(w);
  const s = workers.ensureSession(w)!;
  s.ev.onTurnEnd!({ text: 'It broke.', isError: true, internal: false });
  s.ev.onStatus!('error', 'It broke.');
  assert.equal(x.status, 'failed');
  assert.equal(store.data.chat.filter((c) => c.kind === 'error').length, 1);
});

test('on restart, saved state that disagrees is settled: running on a queued task continues it, an error fails its task', () => {
  // As older versions left them: the Worker ran on after send_to_worker while its task stayed queued ...
  const a = addWorker({ status: 'running', sessionId: 'sa' });
  const ta = addTask(a, { status: 'queued', startedAt: undefined });
  // ... the session died without a result, so the task stayed running ...
  const b = addWorker({ status: 'error', statusText: 'Claude Code native binary failed to launch' });
  const tb = addTask(b, { status: 'running', startedAt: undefined });
  // ... and a limit that paused this one reset while the app was closed.
  const c = addWorker({ sessionId: 'sc' });
  const tc = addTask(c, { status: 'queued', startedAt: undefined });
  workers.resumeAfterRestart();
  assert.deepEqual([a.status, ta.status], ['running', 'running']);
  assert.match(sent.get(a.id)![0], /app restarted/);
  assert.deepEqual([b.status, tb.status], ['error', 'failed']);
  assert.equal(sent.get(b.id), undefined);
  assert.deepEqual([c.status, tc.status], ['running', 'running']);
  assert.match(sent.get(c.id)![0], /usage limit has reset/);
});

test('on restart while every account is limited, no Worker is left running', () => {
  limit(true);
  const a = addWorker({ status: 'running', sessionId: 'sa' });
  const ta = addTask(a, { status: 'queued', startedAt: undefined });
  const b = addWorker({ status: 'waiting', sessionId: 'sb' });
  const tb = addTask(b, { status: 'waiting' });
  workers.resumeAfterRestart();
  assert.deepEqual([a.status, b.status], ['idle', 'idle']);
  assert.deepEqual([ta.status, tb.status], ['queued', 'queued']);
  assert.equal(sent.size, 0);
});
