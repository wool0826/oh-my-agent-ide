import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { workers } from '../src/main/agents/workers';
import { AgentSession } from '../src/main/agents/session';
import { store } from '../src/main/store';
import { loadSettings } from '../src/main/settings';
import { answer } from '../src/main/decisions';
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { ALLOW, type Task, type Worker } from '../src/shared/types';
import { workerDecisions } from '../src/shared/inbox';

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
  Object.assign(store.data, { workers: [], tasks: [], chat: [], pendingUpdates: [], decisions: [] });
  sent.clear();
  limit(false);
  loadSettings().maxWorkers = 3;
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

test('cancelling a paused task drops its held messages, nothing restarts it, and the Worker hears it once', async () => {
  const { w, x } = pausedWorker();
  const held = (workers as unknown as { held: Map<string, string[]> }).held;
  held.set(w.id, ['[User message] Held.']);
  await workers.cancelTask(x.id, 'user');
  assert.equal(x.status, 'cancelled');
  assert.equal(held.has(w.id), false);
  assert.equal(w.statusText, '');
  assert.equal(w.status, 'archived');
  assert.ok(store.data.chat.some((c) => c.text === `Cancelled "${x.title}". It will not start.`));
  assert.match(store.data.pendingUpdates.at(-1)!, /The user cancelled queued work/);
  limit(false);
  workers.retryQueued();
  assert.equal(x.status, 'cancelled');
  assert.equal(sent.get(w.id), undefined);
  workers.send(w.id, 'dispatcher', 'Next.');
  workers.send(w.id, 'dispatcher', 'Again.');
  const msgs = sent.get(w.id)!;
  assert.equal(msgs.length, 2);
  assert.ok(msgs[0].startsWith(`[Cancelled] The user cancelled ${x.id} `), msgs[0]);
  assert.ok(msgs[0].endsWith('\n\n[Dispatcher] Next.'), msgs[0]);
  assert.equal(msgs[1], '[Dispatcher] Again.');
  assert.equal(x.status, 'cancelled');
});

test('a task that never started is cancelled without a note to its Worker', async () => {
  const w = addWorker({ sessionId: 'from-an-earlier-task' });
  addTask(w, { status: 'done', finishedAt: now });
  const x = addTask(w, { status: 'queued', startedAt: null });
  await workers.cancelTask(x.id, 'dispatcher');
  assert.equal(x.status, 'cancelled');
  assert.equal(w.status, 'idle');
  workers.send(w.id, 'dispatcher', 'Next.');
  assert.deepEqual(sent.get(w.id), ['[Dispatcher] Next.']);
  assert.equal(store.data.pendingUpdates.length, 0);
});

test('cancelling a task waiting for a merge cancels the tasks waiting on it, and running work cannot be cancelled', async () => {
  const a = addWorker({ sessionId: 'sa' });
  const run = addTask(a);
  workers.ensureSession(a)!.send('Working.');
  const pr = addTask(addWorker(), { status: 'pr_open', prUrl: 'https://github.com/o/r/pull/1', prState: 'OPEN', finishedAt: now });
  const blocked = addTask(null, { status: 'blocked', afterTaskId: pr.id, startedAt: null });
  const next = addTask(null, { status: 'blocked', afterTaskId: blocked.id, startedAt: null });
  await assert.rejects(async () => workers.cancelTask(run.id, 'user'), /is not waiting in the queue \(In progress\)/);
  await assert.rejects(async () => workers.cancelTask(pr.id, 'user'), /is not waiting in the queue/);
  const rs = await workers.cancelTask(blocked.id, 'user');
  assert.deepEqual(rs.map((r) => [r.id, r.followerOf]), [[blocked.id, null], [next.id, blocked.id]]);
  assert.deepEqual([run.status, pr.status, blocked.status, next.status], ['running', 'pr_open', 'cancelled', 'cancelled']);
  assert.ok(store.data.chat.some((c) => c.text.startsWith('Also cancelled 1 task(s) waiting for it')));
});

test('clearing the queue keeps an open PR whose review work was queued, and leaves running work alone', async () => {
  const { x } = pausedWorker();
  limit(false);
  const a = addWorker({ sessionId: 'sa' });
  const run = addTask(a);
  const rev = addTask(addWorker({ sessionId: 'sr' }), { status: 'queued', prUrl: 'https://github.com/o/r/pull/2', prState: 'OPEN', finishedAt: now });
  const rs = await workers.clearQueue('dispatcher');
  assert.deepEqual(rs.map((r) => [r.id, r.status]).sort(), [[x.id, 'cancelled'], [rev.id, 'pr_open']].sort());
  assert.deepEqual([x.status, rev.status, run.status], ['cancelled', 'pr_open', 'running']);
  assert.ok(store.data.chat.some((c) => c.text === 'Cleared the queue: 2 task(s).'));
  assert.deepEqual(await workers.clearQueue('dispatcher'), []);
});

/** Feed a session what Claude Code would stream, without a process. */
const feed = (s: AgentSession, ...ms: unknown[]) => ms.forEach((m) => (s as unknown as { handle(m: unknown): void }).handle(m));
const said = (text: string) => ({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text }] } });
const turnEnd = (text: string, queued = 0) => ({ type: 'result', subtype: 'success', is_error: false, result: text, queued_turn_count: queued });
const agents = (n: number) => ({ type: 'system', subtype: 'background_tasks_changed', tasks: [
  ...Array.from({ length: n }, (_, i) => ({ task_id: `a${i}`, task_type: 'local_agent', description: 'Explore' })),
  { task_id: 'sh', task_type: 'local_bash', description: 'dev server' },
] });

const PLAN = '# Plan\nWHAT: Add the thing.\nHOW: Change one file.\nOUTPUT: A PR.\n\n## Steps\n1. Edit it.';

/** The Worker calls ExitPlanMode; resolves once the plan card is in the decision inbox (no card if the plan was sent back). */
async function presentPlan(s: AgentSession, plan = PLAN) {
  const opts = { signal: new AbortController().signal, suggestions: [], toolUseID: 'tu' } as unknown as Parameters<CanUseTool>[2];
  const result = s.cfg.canUseTool!('ExitPlanMode', { plan }, opts);
  await tick();
  const card = store.data.decisions.find((d) => d.source === 'plan' && d.status === 'pending')!;
  return { result, card };
}

test('a plan-first turn that ends while its subagents run leaves the task open; approving the plan has the same session build it', async () => {
  // As T-0017 went: the Worker started explorers in the background and ended its turn to wait for them.
  const w = addWorker({ sessionId: 'sid' });
  const x = addTask(w, { planFirst: true });
  const s = workers.ensureSession(w)!;
  assert.equal(s.cfg.permissionMode, 'plan');
  feed(s, agents(3), said('Explorers are still running. I\'ll finish the plan when their results come in.'), turnEnd(''));
  assert.equal(x.status, 'running');
  assert.equal(x.finishedAt, null);
  assert.equal(sent.get(w.id), undefined);
  assert.equal(store.data.chat.filter((c) => c.kind === 'result').length, 0);
  assert.equal(w.status, 'idle');
  // The explorers report back and Claude Code starts a turn by itself: the Worker is at work again.
  feed(s, agents(0), said('Got the reports. Writing the plan.'));
  assert.equal(w.status, 'running');
  const { result, card } = await presentPlan(s);
  assert.equal(x.status, 'waiting');
  assert.deepEqual(card.summary, { what: 'Add the thing.', how: 'Change one file.', output: 'A PR.' });
  answer(card.id, ALLOW);
  const r = (await result)!;
  assert.equal(r.behavior, 'allow');
  assert.deepEqual((r as { updatedPermissions?: unknown[] }).updatedPermissions, [{ type: 'setMode', mode: 'auto', destination: 'session' }]);
  assert.equal(s.cfg.permissionMode, 'auto');
  assert.equal(x.planApproved, true);
  assert.equal(x.status, 'running');
  // Whatever the task message said ("plan only"), the Worker hears that this approval is the go-ahead.
  assert.match(sent.get(w.id)!.at(-1)!, /^\[Plan approved\] .*carry out the plan now in this session/);
  assert.match(store.data.pendingUpdates.at(-1)!, /approved the plan; .* is carrying it out/);
  feed(s, said('RESULT: Built it\nPR: none'), turnEnd('RESULT: Built it\nPR: none'));
  assert.equal(x.status, 'done');
  assert.equal(x.summary, 'Built it');
  // Its own result, not a follow-up on a task that had closed early.
  assert.deepEqual(store.data.chat.filter((c) => c.kind === 'result').map((c) => c.text), ['Built it']);
});

test('a plan-first turn that ends without a plan is reminded once, then waits for instructions without closing', () => {
  const w = addWorker({ sessionId: 'sid' });
  const x = addTask(w, { planFirst: true });
  const s = workers.ensureSession(w)!;
  s.ev.onTurnEnd!({ text: 'I looked around.', isError: false, internal: false });
  assert.equal(x.status, 'running');
  assert.equal(sent.get(w.id)!.length, 1);
  assert.match(sent.get(w.id)![0], /^\[Plan needed\] .*present your plan with ExitPlanMode/);
  s.ev.onTurnEnd!({ text: 'Holding as told.', isError: false, internal: false });
  assert.equal(x.status, 'running');
  assert.equal(x.finishedAt, null);
  assert.equal(sent.get(w.id)!.length, 1);
  assert.ok(store.data.chat.some((c) => c.kind === 'event' && c.ref === x.id && c.text === `${w.id} stopped without a plan for "${x.title}". The task stays open; send it a message to continue.`));
  assert.match(store.data.pendingUpdates.at(-1)!, /is still planning: .*"Holding as told\."/);
  // A turn that fails still fails the task.
  s.ev.onTurnEnd!({ text: 'It broke.', isError: true, internal: false });
  assert.equal(x.status, 'failed');
});

test('a plan without its WHAT / HOW / OUTPUT lines is sent back once, then taken with a summary pulled from its text', async () => {
  const w = addWorker({ sessionId: 'sid' });
  const x = addTask(w, { planFirst: true });
  assert.match((workers as unknown as { taskMessage(w: Worker, x: Task): string }).taskMessage(w, x), /Start the plan with exactly three lines, one sentence each in English: "WHAT: ".*"HOW: ".*"OUTPUT: "/);
  const s = workers.ensureSession(w)!;
  const bare = '# Plan: Add dark mode\n\n## Approach\nAdd a theme setting and swap the CSS variables.\n\n## Verification\nRun the tests and check both themes.';
  const first = await presentPlan(s, bare);
  assert.equal(first.card, undefined);
  const r1 = (await first.result)!;
  assert.equal(r1.behavior, 'deny');
  assert.match((r1 as { message: string }).message, /missing its summary lines.*"WHAT: ".*present it again with ExitPlanMode/);
  assert.equal(x.status, 'running');
  // Left out again: no second round trip, the card gets a summary marked as extracted.
  const second = await presentPlan(s, bare);
  assert.deepEqual(second.card.summary, { what: 'Add dark mode', how: 'Add a theme setting and swap the CSS variables.', output: 'Run the tests and check both themes.', auto: true });
  assert.equal(second.card.code, bare);
  answer(second.card.id, 'Use the system theme too');
  assert.equal((await second.result)!.behavior, 'deny');
  // The revised plan has the lines.
  const third = await presentPlan(s);
  assert.equal(third.card.summary?.auto, undefined);
  answer(third.card.id, ALLOW);
  assert.equal((await third.result)!.behavior, 'allow');
});

test('a turn with more input queued behind it leaves the task to the turn that follows', () => {
  const w = addWorker({ sessionId: 'sid' });
  const x = addTask(w);
  const s = workers.ensureSession(w)!;
  feed(s, said('Plan approved; noted.'), turnEnd('Plan approved; noted.', 1));
  assert.equal(x.status, 'running');
  assert.equal(w.status, 'running');
  feed(s, said('RESULT: Done'), turnEnd('RESULT: Done'));
  assert.equal(x.status, 'done');
  assert.equal(x.summary, 'Done');
});

/* ---------- Worker slots ---------- */

/** A task the Dispatcher just created, not yet given to a Worker. */
const fresh = () => addTask(null, { status: 'queued', startedAt: null });
/** The Worker's turn ends with its report. */
const report = (w: Worker, text = 'RESULT: Done') => workers.sessions.get(w.id)!.ev.onTurnEnd!({ text, isError: false, internal: false });

test('with one slot, a second task waits for it and starts by itself when the first finishes', async () => {
  loadSettings().maxWorkers = 1;
  const a = addWorker();
  const b = addWorker();
  const x1 = fresh();
  const x2 = fresh();
  await workers.assign(x1, a.id, a.model);
  await workers.assign(x2, b.id, b.model);
  await tick();
  assert.equal(x1.status, 'running');
  assert.deepEqual([x2.status, x2.queueReason], ['queued', 'slot']);
  assert.equal(x2.startedAt, null);
  assert.equal(sent.get(b.id), undefined);
  assert.equal(b.statusText, 'Starts when a Worker slot frees up');
  report(a);
  await tick();
  assert.equal(x1.status, 'done');
  assert.equal(x2.status, 'running');
  assert.equal(x2.queueReason, null);
  assert.equal(b.statusText, '');
  assert.ok(sent.get(b.id)![0].startsWith(`[Task ${x2.id}]`), sent.get(b.id)![0]);
});

test('a Worker waiting for an answer keeps its slot; messages to it go out, and a message for a waiting task waits with it', async () => {
  loadSettings().maxWorkers = 1;
  const a = addWorker({ sessionId: 'sa' });
  const ask = addTask(a, { status: 'waiting' });
  workers.ensureSession(a);
  const b = addWorker();
  const x = fresh();
  await workers.assign(x, b.id, b.model);
  assert.equal(x.status, 'queued');
  workers.send(a.id, 'user', 'Here is more context.');
  assert.deepEqual(sent.get(a.id), ['[User message] Here is more context.']);
  workers.send(b.id, 'dispatcher', 'Also check the docs.');
  assert.equal(sent.get(b.id), undefined);
  assert.equal(x.status, 'queued');
  ask.status = 'running';
  report(a);
  await tick();
  assert.equal(x.status, 'running');
  const msgs = sent.get(b.id)!;
  assert.equal(msgs.length, 2);
  assert.ok(msgs[0].startsWith(`[Task ${x.id}]`), msgs[0]);
  assert.equal(msgs[1], '[Dispatcher] Also check the docs.');
});

test('review comments wait for a slot, then go out to the same Worker', () => {
  loadSettings().maxWorkers = 1;
  const a = addWorker({ sessionId: 'sa' });
  addTask(a);
  workers.ensureSession(a);
  const b = addWorker({ sessionId: 'sb' });
  const pr = addTask(b, { status: 'pr_open', prUrl: 'https://github.com/o/r/pull/3', prState: 'OPEN', finishedAt: now });
  workers.sendReview(pr, '- @me (a.ts:1): rename this');
  assert.deepEqual([pr.status, pr.queueReason], ['queued', 'slot']);
  assert.equal(sent.get(b.id), undefined);
  report(a);
  assert.equal(pr.status, 'running');
  assert.equal(sent.get(b.id)!.length, 1);
  assert.match(sent.get(b.id)![0], /^\[Review comments\] New comments on .*rename this/s);
  // Its report settles the task again.
  report(b, 'RESULT: Renamed');
  assert.equal(pr.status, 'pr_open');
});

test('a lower limit stops no running Worker; a higher one starts waiting tasks at once, the longest waiting first', async () => {
  loadSettings().maxWorkers = 2;
  const ws = [addWorker(), addWorker(), addWorker(), addWorker()];
  const xs = ws.map(() => fresh());
  await workers.assign(xs[0], ws[0].id, ws[0].model);
  await workers.assign(xs[1], ws[1].id, ws[1].model);
  loadSettings().maxWorkers = 1;
  await workers.assign(xs[2], ws[2].id, ws[2].model);
  await new Promise((r) => setTimeout(r, 5)); // a later place in the queue
  await workers.assign(xs[3], ws[3].id, ws[3].model);
  assert.deepEqual(xs.map((x) => x.status), ['running', 'running', 'queued', 'queued']);
  // One of two finishing still leaves one running: at the limit, so nothing starts.
  report(ws[0]);
  assert.deepEqual(xs.map((x) => x.status), ['done', 'running', 'queued', 'queued']);
  loadSettings().maxWorkers = 2;
  workers.fillSlots();
  assert.deepEqual(xs.map((x) => x.status), ['done', 'running', 'running', 'queued']);
});

test('a task waiting for a slot can be cancelled, and nothing starts it afterwards', async () => {
  loadSettings().maxWorkers = 1;
  const a = addWorker();
  const b = addWorker();
  const x1 = fresh();
  const x2 = fresh();
  await workers.assign(x1, a.id, a.model);
  await workers.assign(x2, b.id, b.model);
  await workers.cancelTask(x2.id, 'user');
  assert.deepEqual([x2.status, x2.queueReason], ['cancelled', null]);
  report(a);
  await tick();
  assert.equal(x2.status, 'cancelled');
  assert.equal(sent.get(b.id), undefined);
});

test('a merge starts a waiting task only when a slot is free; otherwise it joins the queue', () => {
  loadSettings().maxWorkers = 1;
  const a = addWorker({ sessionId: 'sa' });
  addTask(a);
  workers.ensureSession(a);
  const dep = addTask(addWorker(), { status: 'done', prUrl: 'https://github.com/o/r/pull/4', prState: 'MERGED', finishedAt: now });
  const b = addWorker({ sessionId: 'sb' });
  const next = addTask(b, { status: 'blocked', afterTaskId: dep.id, startedAt: null });
  workers.onPrSettled(dep, true);
  assert.deepEqual([next.status, next.queueReason], ['queued', 'slot']);
  report(a);
  assert.equal(next.status, 'running');
});

test('on restart, interrupted work past the limit waits for a slot and is told to continue when it gets one', () => {
  loadSettings().maxWorkers = 1;
  const a = addWorker({ status: 'running', sessionId: 'sa' });
  const ta = addTask(a);
  const b = addWorker({ status: 'running', sessionId: 'sb' });
  const tb = addTask(b);
  workers.resumeAfterRestart();
  assert.equal(ta.status, 'running');
  assert.match(sent.get(a.id)![0], /app restarted/);
  assert.deepEqual([tb.status, tb.queueReason], ['queued', 'slot']);
  assert.equal(sent.get(b.id), undefined);
  report(a);
  assert.equal(tb.status, 'running');
  assert.equal(sent.get(b.id)!.length, 1);
  assert.match(sent.get(b.id)![0], /app restarted/);
});

test('when a usage limit resets, paused work takes the free slot before a task that waited for one', async () => {
  loadSettings().maxWorkers = 1;
  const { w, x } = pausedWorker();
  const b = addWorker();
  const y = addTask(b, { status: 'queued', queueReason: 'slot', startedAt: null, updatedAt: new Date(Date.now() - 60_000).toISOString() });
  limit(false);
  workers.retryQueued();
  assert.equal(x.status, 'running');
  assert.match(sent.get(w.id)![0], /usage limit has reset/);
  assert.deepEqual([y.status, y.queueReason], ['queued', 'slot']);
  assert.equal(sent.get(b.id), undefined);
});

test('a message to a Worker paused by a usage limit waits for a slot when every slot is taken', () => {
  loadSettings().maxWorkers = 1;
  const { w, x } = pausedWorker();
  limit(false);
  const a = addWorker({ sessionId: 'sa' });
  addTask(a);
  workers.ensureSession(a);
  const before = sent.get(w.id)?.length ?? 0;
  workers.send(w.id, 'user', 'Go on with this.');
  assert.deepEqual([x.status, x.queueReason], ['queued', 'slot']);
  assert.equal(sent.get(w.id)?.length ?? 0, before);
  report(a);
  assert.equal(x.status, 'running');
  assert.deepEqual(sent.get(w.id)!.slice(before), ['[User message] Go on with this.']);
});

test('a Worker archived while its task waits for a slot comes back when the task starts', async () => {
  loadSettings().maxWorkers = 1;
  const a = addWorker();
  const b = addWorker();
  const x1 = fresh();
  const x2 = fresh();
  await workers.assign(x1, a.id, a.model);
  await workers.assign(x2, b.id, b.model);
  await workers.archive(b.id);
  assert.equal(b.status, 'archived');
  report(a);
  await tick();
  assert.equal(x2.status, 'running');
  assert.notEqual(b.status, 'archived');
});

/* ---------- Talking with the Dispatcher ---------- */

/** Times Worker news asked for a Dispatcher turn of its own. */
let wakes = 0;
store.on('wake', () => { wakes += 1; });
beforeEach(() => { wakes = 0; });

/** A Worker with an open session: on a running task, or idle after one whose PR is still open. */
function talking(taskOver: Partial<Task> = {}) {
  const w = addWorker({ sessionId: 'sid' });
  const x = addTask(w, taskOver);
  return { w, x, s: workers.ensureSession(w)! };
}
const finished: Partial<Task> = { status: 'pr_open', finishedAt: now, prUrl: 'https://github.com/o/r/pull/1', prState: 'OPEN' };
/** The Worker's turn says this and ends. */
const turn = (s: AgentSession, text: string) => feed(s, said(text), turnEnd(text));
const chatLines = () => store.data.chat.map((c) => c.text);

test('a question to an idle Worker reopens no task, and what its turn says reaches the Dispatcher as the answer', () => {
  const { w, x, s } = talking(finished);
  assert.equal(workers.ask(w.id, 'Which file holds the parser?'), 'sent');
  assert.equal(x.status, 'pr_open', 'instructions would reopen it as a follow-up; a question does not');
  assert.ok(sent.get(w.id)![0].startsWith('[Dispatcher question] Which file holds the parser?'), sent.get(w.id)![0]);
  assert.equal(w.ask?.text, 'Which file holds the parser?');
  turn(s, 'It is src/parse.ts.');
  assert.equal(w.ask, null);
  assert.equal(x.status, 'pr_open');
  assert.deepEqual(store.data.pendingUpdates, [`${w.id} answered your question "Which file holds the parser?": It is src/parse.ts.`]);
  assert.equal(wakes, 1);
  assert.deepEqual(chatLines(), [`Dispatcher → ${w.id} question: Which file holds the parser?`, `${w.id} → Dispatcher: It is src/parse.ts.`]);
});

test('mid-task, tell_dispatcher answers the question and the task goes on to its own report', () => {
  const { w, x, s } = talking();
  workers.ask(w.id, 'How far along are you?');
  assert.match(workers.fromWorker(w, 'answer', 'Half way: the parser is done.'), /^Delivered/);
  assert.equal(w.ask, null);
  assert.equal(x.status, 'running');
  assert.equal(wakes, 1);
  assert.deepEqual(store.readLog(w.id, undefined, 2).items.map((i) => [i.from, i.text]), [
    ['dispatcher', 'Question: How far along are you?'],
    ['worker', 'To the Dispatcher: Half way: the parser is done.'],
  ]);
  turn(s, 'RESULT: Done');
  assert.equal(x.status, 'done');
  assert.deepEqual(store.data.pendingUpdates, [
    `${w.id} answered your question "How far along are you?": Half way: the parser is done.`,
    `${w.id} ${x.id} "Task" done: Done`,
  ]);
  assert.equal(wakes, 2, 'the result starts a Dispatcher turn too');
});

test('a Worker that answers in plain text mid-task and stops is told to go on; the answer is no task result', () => {
  const { w, x, s } = talking();
  workers.ask(w.id, 'How far along are you?');
  turn(s, 'Half way.');
  assert.equal(x.status, 'running');
  assert.equal(w.ask, null);
  assert.ok(sent.get(w.id)![1].startsWith('[Dispatcher] Your answer was delivered.'), sent.get(w.id)![1]);
  assert.deepEqual(store.data.pendingUpdates, [`${w.id} answered your question "How far along are you?": Half way.`]);
  turn(s, 'RESULT: Done');
  assert.equal(x.status, 'done');
});

test('a Worker that answers with the tool and ends its turn there is told to go on too, once', () => {
  const { w, x, s } = talking();
  workers.ask(w.id, 'How far along are you?');
  workers.fromWorker(w, 'answer', 'Half way.');
  turn(s, 'Answered.');
  assert.equal(x.status, 'running', 'the turn that answered a question says nothing about the task');
  assert.ok(sent.get(w.id)![1].startsWith('[Dispatcher] Your answer was delivered.'), sent.get(w.id)![1]);
  assert.deepEqual(store.data.pendingUpdates, [`${w.id} answered your question "How far along are you?": Half way.`]);
  // The next turn is its report, with the RESULT lines or without.
  turn(s, 'All of it is done now.');
  assert.equal(x.status, 'done');
  assert.equal(sent.get(w.id)!.length, 2);
});

test('a question whose turn fails or says nothing is reported as unanswered, so no later text is taken for the answer', () => {
  const { w, s } = talking(finished);
  workers.ask(w.id, 'Which file?');
  s.ev.onTurnEnd!({ text: 'It broke.', isError: true, internal: false });
  assert.equal(w.ask, null);
  assert.deepEqual(store.data.pendingUpdates, [`${w.id} did not answer your question "Which file?" (It broke.). Ask again if you still need the answer.`]);
  assert.equal(wakes, 1);
});

test('an answer nobody asked for and a note wait for the next Dispatcher turn; empty text is not sent', () => {
  const { w, x } = talking();
  assert.match(workers.fromWorker(w, 'answer', 'By the way, the tests are slow.'), /^Noted/);
  assert.match(workers.fromWorker(w, 'note', 'Half of the files are migrated.'), /^Noted/);
  assert.match(workers.fromWorker(w, 'note', '  '), /^Nothing was sent/);
  assert.deepEqual(store.data.pendingUpdates, [
    `${w.id} (${x.id}) notes: By the way, the tests are slow.`,
    `${w.id} (${x.id}) notes: Half of the files are migrated.`,
  ]);
  assert.equal(wakes, 0);
  assert.deepEqual(chatLines(), []);
});

test('a reply to instructions with no task to report on goes to the Dispatcher instead of being dropped', () => {
  const { w, x, s } = talking({ status: 'done', finishedAt: now, prUrl: 'https://github.com/o/r/pull/1', prState: 'MERGED' });
  assert.equal(workers.send(w.id, 'dispatcher', 'Did the migration touch settings?'), 'sent');
  assert.equal(x.status, 'done', 'a merged task is not reopened');
  turn(s, 'No, only the store.');
  assert.deepEqual(store.data.pendingUpdates, [`${w.id} replied to your message: No, only the store.`]);
  assert.equal(wakes, 0);
  // Only the turn the Dispatcher's message started: a later turn of its own is not reported.
  turn(s, 'Also tidied my notes.');
  assert.equal(store.data.pendingUpdates.length, 1);
});

test('a request the Worker cannot go on without keeps its task open, and the Dispatcher\'s message sets it going again', () => {
  const { w, x, s } = talking();
  assert.match(workers.fromWorker(w, 'request', 'What is W-9 changing in store.ts?'), /^Delivered/);
  assert.equal(w.request?.text, 'What is W-9 changing in store.ts?');
  assert.equal(wakes, 1);
  assert.deepEqual(chatLines(), [`${w.id} → Dispatcher request: What is W-9 changing in store.ts?`]);
  turn(s, 'I will wait for that.');
  assert.equal(x.status, 'waiting');
  assert.equal(w.status, 'idle');
  assert.equal(w.statusText, 'Waiting for the Dispatcher');
  assert.match(store.data.pendingUpdates[0], new RegExp(`^${w.id} \\(${x.id} "Task"\\) asks you: What is W-9 changing in store\\.ts\\?`));
  // The Dispatcher may have done something about the request without writing back: it hears that the task stopped for it.
  assert.equal(wakes, 2);
  assert.match(store.data.pendingUpdates[1], new RegExp(`^${w.id} \\(${x.id} "Task"\\) stopped and waits for your reply to what it asked: What is W-9 changing in store\\.ts\\?\\n  Its task stays open and keeps its Worker slot until the Worker hears from you`));
  assert.equal(store.data.pendingUpdates.length, 2);

  assert.equal(workers.send(w.id, 'dispatcher', 'Only pushUpdate.'), 'sent');
  assert.equal(w.request, null);
  assert.equal(x.status, 'running');
  assert.equal(sent.get(w.id)![0], '[Dispatcher] Only pushUpdate.');
  turn(s, 'RESULT: Done');
  assert.equal(x.status, 'done');
});

test('a BLOCKED report keeps the task open with its slot and tells the Dispatcher; a request that the task outlived is closed with it', () => {
  loadSettings().maxWorkers = 1;
  const { w, x, s } = talking();
  turn(s, 'I looked everywhere.\nBLOCKED: I need the name of the staging bucket.');
  assert.equal(x.status, 'waiting');
  assert.equal(w.request?.text, 'I need the name of the staging bucket.');
  assert.equal(wakes, 1);
  assert.match(store.data.pendingUpdates[0], /is blocked and waits for you: I need the name of the staging bucket\./);
  assert.deepEqual(chatLines(), [`${w.id} is blocked and waits for the Dispatcher: I need the name of the staging bucket.`]);
  // Still holding the only slot.
  const b = addWorker();
  const y = fresh();
  return workers.assign(y, b.id, b.model).then(() => {
    assert.equal(y.status, 'queued');
    workers.send(w.id, 'user', 'It is stage-eu.');
    assert.equal(x.status, 'running');
    workers.fromWorker(w, 'request', 'Is W-9 done?');
    turn(s, 'RESULT: Done');
    assert.equal(x.status, 'done');
    assert.equal(w.request, null);
  });
});

test('past five requests in one task, more of them wait for the next Dispatcher turn', () => {
  const { w } = talking();
  for (let i = 1; i <= 7; i++) workers.fromWorker(w, 'request', `Request ${i}`);
  assert.equal(wakes, 5);
  assert.equal(store.data.pendingUpdates.length, 7);
});

test('with no task open the same holds per Worker, and the count starts over when it is answered', () => {
  const { w } = talking({ status: 'done', finishedAt: now, prUrl: 'https://github.com/o/r/pull/1', prState: 'MERGED' });
  for (let i = 1; i <= 7; i++) workers.fromWorker(w, 'request', `Request ${i}`);
  assert.equal(wakes, 5);
  workers.send(w.id, 'dispatcher', 'Here is what you asked for.');
  assert.equal(w.request, null);
  workers.fromWorker(w, 'request', 'One more thing.');
  assert.equal(wakes, 6);
});

test('a turn that ends without a report while its subagents run does not finish the task', () => {
  const { x, s } = talking();
  feed(s, agents(1), said('Explorers are still running.'), turnEnd('Explorers are still running.'));
  assert.equal(x.status, 'running');
  assert.deepEqual(store.data.pendingUpdates, []);
  feed(s, agents(0), said('RESULT: Done'), turnEnd('RESULT: Done'));
  assert.equal(x.status, 'done');
});

test('a question held by a usage limit goes out when it resets, still without reopening a task', () => {
  const w = addWorker({ sessionId: 'sid' });
  const x = addTask(w, finished);
  limit(true);
  assert.equal(workers.ask(w.id, 'Which file?'), 'limit');
  limit(false);
  workers.retryQueued();
  assert.ok(sent.get(w.id)![0].startsWith('[Dispatcher question] Which file?'), sent.get(w.id)![0]);
  assert.equal(x.status, 'pr_open');
});

test('on restart a task that waits for the Dispatcher is not told to continue, and an open question is given back', () => {
  const w = addWorker({ sessionId: 'sid', request: { text: 'Need the bucket name.', at: now }, ask: { text: 'Which file?', at: now } });
  const x = addTask(w, { status: 'waiting' });
  workers.resumeAfterRestart();
  assert.equal(sent.get(w.id), undefined);
  assert.equal(x.status, 'waiting');
  assert.equal(w.ask, null);
  assert.deepEqual(store.data.pendingUpdates, [`${w.id} did not answer your question "Which file?" (the app restarted). Ask again if you still need the answer.`]);
  assert.equal(wakes, 0);
});

test('a Worker session leaves out the tools it never needs, caps command output, and has its own tools allowed in any mode', async () => {
  const { s } = talking();
  assert.deepEqual(s.cfg.disallowedTools, ['Workflow', 'ScheduleWakeup', 'ReportFindings', 'ListAgents']);
  assert.equal((s.cfg.settings as { bashOutputMaxChars: number }).bashOutputMaxChars, 12_000);
  const opts = { signal: new AbortController().signal, suggestions: [], toolUseID: 'tu' } as unknown as Parameters<CanUseTool>[2];
  const input = { kind: 'note', text: 'Hi' };
  assert.deepEqual(await s.cfg.canUseTool!('mcp__oma__tell_dispatcher', input, opts), { behavior: 'allow', updatedInput: input });
});

test('a task waiting for one that finishes without a PR starts then, and the Dispatcher hears it', async () => {
  const a = addWorker({ sessionId: 'sa' });
  const dep = addTask(a, { title: 'Research' });
  workers.ensureSession(a);
  const b = addWorker({ sessionId: 'sb' });
  const next = addTask(b, { status: 'blocked', afterTaskId: dep.id, startedAt: null });
  report(a, 'RESULT: Wrote the notes');
  assert.equal(dep.status, 'done');
  assert.equal(next.status, 'running');
  await tick();
  assert.match(sent.get(b.id)?.[0] ?? '', new RegExp(`waited for ${dep.id} "Research", which finished without a PR: Wrote the notes`));
  assert.ok(store.data.pendingUpdates.some((u) => u.startsWith(`${next.id} "Task" (${b.id}) waited for ${dep.id}, which finished without a PR; it started`)));
});

test('a task waiting for one that fails is cancelled with the tasks waiting on it, and the Dispatcher hears why', async () => {
  const a = addWorker({ sessionId: 'sa' });
  const dep = addTask(a);
  const s = workers.ensureSession(a)!;
  const next = addTask(addWorker(), { status: 'blocked', afterTaskId: dep.id, startedAt: null });
  const last = addTask(addWorker(), { status: 'blocked', afterTaskId: next.id, startedAt: null });
  s.ev.onTurnEnd!({ text: 'It broke.', isError: true, internal: false });
  assert.deepEqual([dep.status, next.status, last.status], ['failed', 'cancelled', 'cancelled']);
  assert.ok(store.data.chat.some((c) => c.text === `Cancelled "Task": "Task" ended without a PR to merge`));
  assert.ok(store.data.pendingUpdates.some((u) => u.includes(`${dep.id} "Task" ended as failed with no PR to merge, so the tasks waiting for it were cancelled: ${next.id} "Task" cancelled (it waited for ${dep.id}); ${last.id} "Task" cancelled (it waited for ${next.id})`)));
  await tick();
});

test('a review fix that fails leaves its PR open, so the task waiting for the merge keeps waiting', () => {
  const a = addWorker({ sessionId: 'sa' });
  const dep = addTask(a, { prUrl: 'https://github.com/o/r/pull/7', prState: 'OPEN', finishedAt: now });
  const s = workers.ensureSession(a)!;
  const next = addTask(addWorker(), { status: 'blocked', afterTaskId: dep.id, startedAt: null });
  s.ev.onTurnEnd!({ text: 'It broke.', isError: true, internal: false });
  assert.deepEqual([dep.status, next.status], ['failed', 'blocked']);
});

test('a PR closed without merging cancels the tasks waiting for it, and the ones waiting on those', async () => {
  const dep = addTask(addWorker(), { status: 'done', prUrl: 'https://github.com/o/r/pull/8', prState: 'CLOSED', finishedAt: now });
  const next = addTask(addWorker(), { status: 'blocked', afterTaskId: dep.id, startedAt: null });
  const last = addTask(addWorker(), { status: 'blocked', afterTaskId: next.id, startedAt: null });
  workers.onPrSettled(dep, false);
  assert.deepEqual([next.status, last.status], ['cancelled', 'cancelled']);
  assert.equal(store.data.chat.filter((c) => c.kind === 'error').length, 1);
  await tick();
});

test('on restart, a task left waiting for one that already ended without a PR starts', () => {
  const dep = addTask(addWorker(), { status: 'done', finishedAt: now });
  const b = addWorker({ sessionId: 'sb' });
  const next = addTask(b, { status: 'blocked', afterTaskId: dep.id, startedAt: null });
  workers.resumeAfterRestart();
  assert.equal(next.status, 'running');
});

test('a Worker waiting on a permission goes on once that decision is answered with text: the tool is denied with what the user said', async () => {
  const w = addWorker({ sessionId: 'sid' });
  const x = addTask(w);
  const s = workers.ensureSession(w)!;
  s.ev.onStatus!('busy', '');
  const opts = { signal: new AbortController().signal, suggestions: [], toolUseID: 'tu' } as unknown as Parameters<CanUseTool>[2];
  const result = s.cfg.canUseTool!('Bash', { command: 'rm -rf build' }, opts);
  await tick();
  assert.deepEqual([w.status, x.status], ['waiting', 'waiting']);
  const open = workerDecisions(store.data.decisions, w.id);
  assert.equal(open.length, 1);
  answer(open[0].id, 'Use npm run clean instead');
  assert.deepEqual(await result, { behavior: 'deny', message: 'The user denied this and said: Use npm run clean instead' });
  assert.deepEqual([w.status, x.status], ['running', 'running']);
  assert.deepEqual(workerDecisions(store.data.decisions, w.id), []);
});
