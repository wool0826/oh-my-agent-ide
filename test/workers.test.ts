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

/** The Worker calls ExitPlanMode; resolves once the plan card is in the decision inbox. */
async function presentPlan(s: AgentSession) {
  const opts = { signal: new AbortController().signal, suggestions: [], toolUseID: 'tu' } as unknown as Parameters<CanUseTool>[2];
  const result = s.cfg.canUseTool!('ExitPlanMode', { plan: '# Plan' }, opts);
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
