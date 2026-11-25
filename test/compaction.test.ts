import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentSession, sessionSettings, type CompactEvent } from '../src/main/agents/session';
import { workers } from '../src/main/agents/workers';
import { dispatcher } from '../src/main/agents/dispatcher';
import { accounts } from '../src/main/accounts';
import { store } from '../src/main/store';
import { loadSettings } from '../src/main/settings';
import { COMPACT_AT, COMPACT_MIN_GROWTH, CONTEXT_WINDOW, WORKER_TASK_COMPACT, shouldCompact } from '../src/shared/context';
import type { Task, Worker } from '../src/shared/types';
import { DISPATCHER_COMPACT, WORKER_COMPACT, compactCommand } from '../src/shared/compactInstructions';

// Settings and the IDE home live in a temp folder. Two accounts, so a limit can move a session to the other one.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-compact-'));
process.env.OMA_DATA_DIR = tmp;
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({
  home: path.join(tmp, 'home'), language: 'en', claudeRules: false, claudeMemory: false, selfReview: false,
  accounts: [{ id: 'a1', label: 'One', kind: 'login', plan: 'team' }, { id: 'a2', label: 'Two', kind: 'login', plan: 'team' }],
}));

/** Every start of a session, with what it was sent. No Claude Code process is started. */
let starts: { account: string | null; sent: string[] }[] = [];
AgentSession.prototype.start = function () {
  const run = { account: this.cfg.accountId, sent: [] as string[] };
  starts.push(run);
  Object.assign(this, { input: { push: (m: any) => run.sent.push(m.message.content), close() {} }, q: { close() {} } });
  this.ev.onAccount?.(this.cfg.accountId);
};
const sent = () => starts[starts.length - 1]?.sent ?? [];

const LIMIT_TEXT = "Error during compaction: You've hit your 5-hour limit · resets 12:10am (Asia/Seoul)";
const feed = (s: unknown, m: Record<string, unknown>) => (s as unknown as { handle(m: unknown): void }).handle(m);
const assistant = (tokens: number, text = 'Working on it.') => ({
  type: 'assistant', parent_tool_use_id: null,
  message: { model: 'claude-opus-5-5', content: [{ type: 'text', text }], usage: { input_tokens: 10, cache_read_input_tokens: tokens - 10, cache_creation_input_tokens: 0, output_tokens: 0 } },
});
/** What Claude Code answers when /compact fails: its own text, then a result that is not an error. */
const compactError = (text: string) => ({
  type: 'assistant', parent_tool_use_id: null,
  message: { model: '<synthetic>', content: [{ type: 'text', text }], usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 } },
});
const result = (over: Record<string, unknown> = {}) => ({ type: 'result', subtype: 'success', is_error: false, result: '', ...over });
const status = (over: Record<string, unknown>) => ({ type: 'system', subtype: 'status', status: null, ...over });
const boundary = (pre: number, post: number, trigger = 'manual') => ({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger, pre_tokens: pre, post_tokens: post } });

function open(accountId = 'a1') {
  const events: CompactEvent[] = [];
  const statuses: string[] = [];
  let limited = 0;
  const s = new AgentSession({ label: 'S', model: 'claude-opus-5-5', cwd: tmp, systemAppend: '', accountId, resume: null }, {
    onCompact: (e) => events.push(e),
    onStatus: (st) => statuses.push(st),
    onLimited: () => { limited += 1; },
  });
  s.start();
  return { s, events, statuses, limited: () => limited };
}

const limit = (id: string, on: boolean) => {
  loadSettings().accounts.find((a) => a.id === id)!.limitedUntil = on ? new Date(Date.now() + 3600_000).toISOString() : null;
};
const tick = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  starts = [];
  limit('a1', false);
  limit('a2', false);
});

test('sessions give Claude Code the app window, so it compacts by itself (mid-turn too) before reaching it', () => {
  assert.equal(CONTEXT_WINDOW, 250_000);
  assert.equal(COMPACT_AT, 200_000);
  assert.deepEqual(sessionSettings(undefined), { autoCompactWindow: CONTEXT_WINDOW });
  assert.deepEqual(sessionSettings({ autoMemoryEnabled: false }), { autoMemoryEnabled: false, autoCompactWindow: CONTEXT_WINDOW });
});

test('a turn ending at 80% of the window compacts the idle session; just below it does not', () => {
  const { s, events, statuses } = open();
  s.send('Task one');
  feed(s, assistant(COMPACT_AT - 1));
  feed(s, result());
  assert.deepEqual(sent(), ['Task one']);
  assert.equal(events.length, 0);

  s.send('Task two');
  feed(s, assistant(COMPACT_AT));
  feed(s, result());
  assert.deepEqual(sent(), ['Task one', 'Task two', '/compact']);
  assert.deepEqual(events, [{ phase: 'start', tokens: COMPACT_AT }]);
  assert.equal(s.busy, true);

  // Claude Code also says it is compacting; that is the same compaction.
  feed(s, status({ status: 'compacting' }));
  feed(s, boundary(COMPACT_AT + 600, 9_000));
  feed(s, result());
  assert.deepEqual(events, [{ phase: 'start', tokens: COMPACT_AT }, { phase: 'done', from: COMPACT_AT + 600, to: 9_000 }]);
  assert.equal(s.contextTokens, 9_000);
  assert.equal(s.busy, false);
  assert.equal(statuses[statuses.length - 1], 'idle');
  assert.equal(sent().length, 3, 'the compaction turn itself never triggers another one');
});

test("Claude Code's own compaction in the middle of a turn shows as started and done", () => {
  const { s, events } = open();
  s.send('Long task');
  feed(s, assistant(216_000));
  feed(s, status({ status: 'compacting' }));
  feed(s, status({ status: 'compacting', compact_output_chars: 1200 }));
  assert.deepEqual(events, [{ phase: 'start', tokens: 216_000 }]);
  feed(s, boundary(217_400, 12_000, 'auto'));
  feed(s, status({ compact_result: 'success' }));
  feed(s, assistant(15_000, 'Done.'));
  feed(s, result({ result: 'Done.' }));
  assert.deepEqual(events, [{ phase: 'start', tokens: 216_000 }, { phase: 'done', from: 217_400, to: 12_000 }]);
  assert.deepEqual(sent(), ['Long task']);
});

test('a /compact a usage limit stops is retried on another account; nothing is in error or paused', async () => {
  const { s, events, statuses, limited } = open('a1');
  feed(s, assistant(120_000));
  s.compact();
  feed(s, compactError(LIMIT_TEXT));
  feed(s, result());
  await tick();
  assert.deepEqual(events.slice(0, 2), [{ phase: 'start', tokens: 120_000 }, { phase: 'failed', error: LIMIT_TEXT, limited: true }]);
  assert.ok(!accounts.isFree('a1'), 'the account the limit rejected is held');
  assert.equal(s.accountId, 'a2');
  assert.equal(starts.length, 2);
  assert.deepEqual(sent(), ['/compact'], 'the resumed session compacts; it is not told to continue a task');
  assert.deepEqual(events[2], { phase: 'start', tokens: 120_000 });
  assert.ok(!statuses.includes('error'));
  assert.equal(limited(), 0);

  feed(s, boundary(120_500, 8_000));
  feed(s, result());
  assert.deepEqual(events[3], { phase: 'done', from: 120_500, to: 8_000 });
  assert.equal(statuses[statuses.length - 1], 'idle');
});

test('with every other account at its limit, a failed compaction leaves the session idle and pauses nothing', async () => {
  limit('a2', true);
  const { s, events, statuses, limited } = open('a1');
  feed(s, assistant(90_000));
  s.compact();
  feed(s, status({ compact_result: 'failed', compact_error: "You've hit your 5-hour limit" }));
  feed(s, result({ is_error: true, result: "You've hit your 5-hour limit" }));
  await tick();
  assert.equal(events.filter((e) => e.phase === 'failed').length, 1);
  assert.equal(starts.length, 1);
  assert.equal(s.busy, false);
  assert.equal(statuses[statuses.length - 1], 'idle');
  assert.equal(limited(), 0, 'a compaction cut nothing off, so no task or Dispatcher turn is paused');
});

test('a compaction that fails for another reason is reported, without failover or an error status', () => {
  const { s, events, statuses } = open('a1');
  feed(s, assistant(50_000));
  s.compact();
  feed(s, compactError('Error: No messages to compact'));
  feed(s, result());
  assert.deepEqual(events[1], { phase: 'failed', error: 'Error: No messages to compact', limited: false });
  assert.ok(accounts.isFree('a1'));
  assert.equal(starts.length, 1);
  assert.equal(statuses[statuses.length - 1], 'idle');
});

// --- Owners: what the Worker view and the Dispatcher chat show

const now = new Date().toISOString();

function worker(): { w: Worker; x: Task } {
  const w: Worker = {
    id: 'W-1', title: 'Worker', model: 'claude-opus-5-5', accountId: 'a1', sessionId: 'sid', cwd: tmp, repo: null,
    status: 'running', statusText: '', contextTokens: 0, taskIds: [], createdAt: now, lastActiveAt: now, knowledge: '',
  };
  const x: Task = {
    id: 'T-1', title: 'Task', prompt: 'Do it.', kind: 'other', repo: null, workerId: w.id, status: 'running',
    branch: null, prUrl: null, prState: null, summary: null, files: [], createdAt: now, updatedAt: now, startedAt: now,
    finishedAt: null, reviewSyncedAt: null, seenCommentIds: [],
  };
  w.taskIds.push(x.id);
  Object.assign(store.data, { workers: [w], tasks: [x], chat: [], pendingUpdates: [] });
  return { w, x };
}

test("a Worker's compaction is shown in its conversation, and a limit that stops it does not fail the task", async () => {
  workers.closeAll();
  const { w, x } = worker();
  const s = workers.ensureSession(w)!;
  s.send('Task');
  feed(s, assistant(216_000));
  feed(s, status({ status: 'compacting' }));
  assert.equal(w.statusText, 'Compacting the conversation…');
  feed(s, status({ compact_result: 'failed', compact_error: "You've hit your 5-hour limit" }));
  assert.equal(w.statusText, '');
  assert.equal(x.status, 'running');
  assert.notEqual(w.status, 'error');
  const log = store.readLog(w.id).items.filter((i) => i.from === 'event').map((i) => i.text);
  assert.deepEqual(log, [
    'Compacting the conversation (216K)…',
    "Could not compact the conversation (You've hit your 5-hour limit). The work goes on; it is compacted again later.",
  ]);
  workers.closeAll();
});

test('a Worker is not compacted when its task finishes, only before its next task', async () => {
  workers.closeAll();
  const { w, x } = worker();
  const s = workers.ensureSession(w)!;
  s.send('Task');
  // The turn ends with the task still open: it waits for the Dispatcher.
  feed(s, assistant(WORKER_TASK_COMPACT + 5_000, 'BLOCKED: I need the bucket name.'));
  feed(s, result({ result: 'BLOCKED: I need the bucket name.' }));
  assert.equal(x.status, 'waiting');
  s.send('[Dispatcher] It is stage-eu.');
  feed(s, assistant(WORKER_TASK_COMPACT + 26_000, 'RESULT: Done'));
  feed(s, result({ result: 'RESULT: Done' }));
  assert.equal(x.status, 'done');
  // Finished above the threshold: nothing is compacted, so a question about the task still has all of it.
  s.send('[Dispatcher question] Which file?');
  feed(s, assistant(WORKER_TASK_COMPACT + 27_000, 'src/parse.ts'));
  feed(s, result({ result: 'src/parse.ts' }));
  assert.deepEqual(sent(), ['Task', '[Dispatcher] It is stage-eu.', '[Dispatcher question] Which file?']);

  // A new task: compacted first, and the task message waits for that.
  const next: Task = { ...x, id: 'T-2', title: 'Next', prompt: 'Do the next thing.', status: 'running', startedAt: undefined };
  store.data.tasks.push(next);
  w.taskIds.push(next.id);
  (workers as unknown as { startTask(w: Worker, s: unknown, t: Task): void }).startTask(w, s, next);
  await tick();
  assert.deepEqual(sent().slice(3), [compactCommand(WORKER_COMPACT)]);
  feed(s, boundary(WORKER_TASK_COMPACT + 27_000, 30_000));
  feed(s, result());
  assert.equal(sent().length, 5);
  assert.match(sent()[4], /^\[Task T-2\] Next/);
  workers.closeAll();
});

test('a new task under the threshold, or hardly grown since the last compaction, starts without one', async () => {
  workers.closeAll();
  const { w, x } = worker();
  let s = workers.ensureSession(w) as AgentSession;
  const start = async (id: string) => {
    const t: Task = { ...x, id, title: id, status: 'running', startedAt: undefined };
    store.data.tasks.push(t);
    (workers as unknown as { startTask(w: Worker, s: unknown, t: Task): void }).startTask(w, s, t);
    await tick();
  };
  s.contextTokens = WORKER_TASK_COMPACT - 1;
  await start('T-2');
  assert.deepEqual(sent().map((m) => m.slice(0, 10)), ['[Task T-2]']);
  feed(s, result({ result: 'RESULT: Done' }));
  // A session reopened since (it read no size yet) goes by the size the Worker last showed.
  workers.closeAll();
  s = workers.ensureSession(w) as AgentSession;
  w.contextTokens = WORKER_TASK_COMPACT + COMPACT_MIN_GROWTH;
  await start('T-3');
  assert.deepEqual(sent(), [compactCommand(WORKER_COMPACT)]);
  assert.equal(s.contextTokens, WORKER_TASK_COMPACT + COMPACT_MIN_GROWTH);
  assert.equal(shouldCompact(WORKER_TASK_COMPACT + COMPACT_MIN_GROWTH - 1, WORKER_TASK_COMPACT, WORKER_TASK_COMPACT), false);
  assert.equal(shouldCompact(WORKER_TASK_COMPACT + COMPACT_MIN_GROWTH, WORKER_TASK_COMPACT, WORKER_TASK_COMPACT), true);
  workers.closeAll();
});

test('a Stop during the compaction before a task stops only the compaction: the task still goes out', async () => {
  const s = new AgentSession({ label: 'S', model: 'claude-opus-5-5', cwd: tmp, systemAppend: '', accountId: 'a1', resume: 'sid' }, {});
  assert.equal(s.compactFirst(WORKER_TASK_COMPACT, WORKER_TASK_COMPACT + 30_000), true);
  s.send('[Task T-2] Next');
  await s.interrupt();
  feed(s, result({ subtype: 'error_during_execution', is_error: true, errors: ['Interrupted'] }));
  await tick();
  assert.deepEqual(sent(), [compactCommand(undefined), '[Task T-2] Next']);
  assert.equal(s.busy, true);
  s.close();
});

test('a task message that waited for a compaction a limit stopped goes on another account, or back to the owner', () => {
  const held: string[][] = [];
  const s = new AgentSession({ label: 'S', model: 'claude-opus-5-5', cwd: tmp, systemAppend: '', accountId: 'a1', resume: 'sid' }, {
    onLimited: (h) => { held.push(h ?? []); },
  });
  assert.equal(s.compactFirst(WORKER_TASK_COMPACT, WORKER_TASK_COMPACT + 30_000), true);
  s.send('[Task T-2] Next');
  assert.deepEqual(sent(), [compactCommand(undefined)]);
  // The other account takes over and compacts; then the task goes out there.
  feed(s, compactError(LIMIT_TEXT));
  feed(s, result());
  assert.equal(starts.length, 2);
  assert.deepEqual(sent(), [compactCommand(undefined)]);
  feed(s, boundary(WORKER_TASK_COMPACT + 30_000, 20_000));
  feed(s, result());
  assert.deepEqual(sent(), [compactCommand(undefined), '[Task T-2] Next']);

  // Every account limited: the message goes back to the owner instead of being lost.
  feed(s, assistant(21_000));
  feed(s, assistant(WORKER_TASK_COMPACT + 45_000, 'Done'));
  feed(s, result({ result: 'Done' }));
  assert.equal(s.compactFirst(WORKER_TASK_COMPACT), true);
  s.send('[Task T-3] Later');
  limit('a1', true);
  feed(s, compactError(LIMIT_TEXT));
  feed(s, result());
  assert.deepEqual(held, [['[Task T-3] Later']]);
  s.close();
});

test('a Worker runs with a 5-minute prompt cache and without the bundled skills; the Dispatcher keeps its own', () => {
  workers.closeAll();
  const { w } = worker();
  assert.deepEqual((workers.ensureSession(w) as AgentSession).cfg.env, { FORCE_PROMPT_CACHING_5M: '1', CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1' });
  assert.equal((dispatcher as unknown as { open(): AgentSession }).open().cfg.env, undefined);
  workers.closeAll();
});

test('the Dispatcher chat says when its conversation was compacted, and why it could not be', () => {
  worker();
  const s = (dispatcher as unknown as { open(): AgentSession }).open();
  s.ev.onCompact!({ phase: 'start', tokens: 210_000 });
  assert.equal(dispatcher.statusText, 'Compacting the conversation…');
  s.ev.onCompact!({ phase: 'done', from: 210_000, to: 9_000 });
  s.ev.onCompact!({ phase: 'failed', error: LIMIT_TEXT, limited: true });
  assert.equal(dispatcher.statusText, '');
  assert.deepEqual(store.data.chat.map((c) => [c.kind, c.text]), [
    ['event', 'Compacted the Dispatcher conversation (210K → 9K).'],
    ['error', `Could not compact the Dispatcher conversation (${LIMIT_TEXT}). Nothing was lost; it can be compacted again later.`],
  ]);
  dispatcher.close();
});

test("the app's /compact asks to keep what matters for the session's role; without instructions it is bare", () => {
  assert.equal(compactCommand(), '/compact');
  assert.equal(compactCommand('  Keep\n the  task. '), '/compact Keep the task.');
  for (const text of [DISPATCHER_COMPACT, WORKER_COMPACT]) assert.doesNotMatch(compactCommand(text), /\n/);
  assert.match(DISPATCHER_COMPACT, /preferences.*tasks? with its ID.*Worker.*PRs.*decisions.*questions.*latest request/);
  assert.match(WORKER_COMPACT, /goal.*definition of done.*steps.*branch.*files changed.*PR.*constraints.*failing tests.*next steps/);

  workers.closeAll();
  const { w } = worker();
  assert.equal((workers.ensureSession(w) as AgentSession).cfg.compactInstructions, WORKER_COMPACT);
  workers.closeAll();
  const d = (dispatcher as unknown as { open(): AgentSession }).open();
  assert.equal(d.cfg.compactInstructions, DISPATCHER_COMPACT);
  d.compact();
  assert.deepEqual(sent(), [compactCommand(DISPATCHER_COMPACT)]);
  dispatcher.close();
});
