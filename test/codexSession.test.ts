import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexSession, type CodexSessionConfig } from '../src/main/agents/codexSession';
import type { CodexLink, ThreadSink } from '../src/main/codex/client';
import { commandShell, isUsageLimit, itemTool, limitWindows, plainCommand, usageSpend } from '../src/shared/codexEvents';

// Marking an account as limited reads the settings file: keep it out of the real profile.
process.env.OMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-codex-'));

/** Stands in for `codex app-server`: records what the session asks and lets the test speak as Codex. */
class FakeCodex implements CodexLink {
  calls: { method: string; params: any }[] = [];
  sinks = new Map<string, ThreadSink>();
  failResume = false;
  private turn = 0;
  async request<T>(method: string, params?: any): Promise<T> {
    this.calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'th-new' } } as T;
    if (method === 'thread/resume') {
      if (this.failResume) throw new Error('thread/resume: no rollout found');
      return { thread: { id: params.threadId } } as T;
    }
    if (method === 'turn/start') return { turn: { id: `turn-${++this.turn}` } } as T;
    return {} as T;
  }
  subscribe(threadId: string, sink: ThreadSink) { this.sinks.set(threadId, sink); return () => this.sinks.delete(threadId); }
  of(method: string) { return this.calls.filter((c) => c.method === method); }
  say(threadId: string, method: string, params: any = {}) { this.sinks.get(threadId)!.notify(method, { threadId, ...params }); }
  ask(threadId: string, method: string, params: any = {}) { return this.sinks.get(threadId)!.request(method, { threadId, ...params }); }
}

const tick = () => new Promise((r) => setImmediate(r));

function session(patch: Partial<CodexSessionConfig> = {}) {
  const codex = new FakeCodex();
  const log: string[] = [];
  const ends: any[] = [];
  const s = new CodexSession({ label: 'W-01', model: 'gpt-test', cwd: '/repo', instructions: 'You are a Worker.', accountId: null, resume: null, ...patch }, {
    onInit: (id) => log.push(`init ${id}`),
    onText: (t) => log.push(`text ${t}`),
    onTool: (n, sum) => log.push(`tool ${n}: ${sum}`),
    onTurnEnd: (r) => { ends.push(r); log.push(`end ${r.isError ? 'error' : 'ok'} ${r.text}`); },
    onStatus: (st, text) => log.push(`status ${st}${text ? ` ${text}` : ''}`),
    onContext: (n) => log.push(`context ${n}`),
    onSpend: (turn) => log.push(`spend in=${turn.input} out=${turn.output} cache=${turn.cacheRead}`),
    onLimited: () => log.push('limited'),
    onCompact: (e) => log.push(`compact ${e.phase}`),
  }, codex);
  return { s, codex, log, ends };
}

test('the first message starts a thread with the role, the sandbox and the app tools, then a turn', async () => {
  const { s, codex, log } = session({ tools: [{ name: 'tell_dispatcher', description: 'Report', inputSchema: { type: 'object' }, run: () => 'ok' }], effort: 'high' });
  s.send('Fix the login bug.');
  await tick();
  const start = codex.of('thread/start')[0].params;
  assert.equal(start.developerInstructions, 'You are a Worker.');
  assert.equal(start.sandbox, 'workspace-write');
  assert.equal(start.approvalPolicy, 'on-request');
  assert.deepEqual(start.dynamicTools.map((t: any) => t.name), ['tell_dispatcher']);
  const turn = codex.of('turn/start')[0].params;
  assert.deepEqual(turn.input, [{ type: 'text', text: 'Fix the login bug.', text_elements: [] }]);
  assert.equal(turn.effort, 'high');
  assert.equal(s.sessionId, 'th-new');
  assert.equal(s.busy, true);
  assert.deepEqual(log.slice(0, 2), ['status busy', 'init th-new']);
});

test('a turn reports its tools, its text, its tokens and its end', async () => {
  const { s, codex, log, ends } = session();
  s.send('go');
  await tick();
  codex.say('th-new', 'turn/started', { turn: { id: 'turn-1' } });
  codex.say('th-new', 'item/started', { item: { type: 'commandExecution', id: 'c1', command: 'npm test' } });
  codex.say('th-new', 'item/started', { item: { type: 'fileChange', id: 'f1', changes: [{ path: 'C:\\repo\\src\\a.ts' }, { path: '/repo/b.ts' }] } });
  codex.say('th-new', 'item/completed', { item: { type: 'agentMessage', id: 'm1', text: 'Looking at it.' } });
  codex.say('th-new', 'item/completed', { item: { type: 'agentMessage', id: 'm2', text: 'RESULT: fixed' } });
  codex.say('th-new', 'thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 1000, cachedInputTokens: 400, outputTokens: 50 }, last: { totalTokens: 1050 } } });
  codex.say('th-new', 'turn/completed', { turn: { id: 'turn-1', status: 'completed', error: null } });
  assert.deepEqual(log.slice(2), ['tool Bash: $ npm test', 'tool Edit: Edit a.ts, b.ts', 'text Looking at it.', 'text RESULT: fixed', 'context 1050', 'spend in=600 out=50 cache=400', 'end ok RESULT: fixed', 'status idle']);
  assert.deepEqual(ends[0], { text: 'RESULT: fixed', isError: false, internal: false, queued: false, background: false });
  assert.equal(s.busy, false);
  assert.equal(s.contextTokens, 1050);
});

test('messages sent while a turn runs wait and go out together as the next turn', async () => {
  const { s, codex, ends } = session();
  s.send('one');
  await tick();
  s.send('two');
  s.send('three');
  await tick();
  assert.equal(codex.of('turn/start').length, 1);
  codex.say('th-new', 'turn/completed', { turn: { status: 'completed' } });
  assert.equal(ends[0].queued, true);
  assert.equal(s.busy, true);
  await tick();
  assert.deepEqual(codex.of('turn/start')[1].params.input.map((i: any) => i.text), ['two', 'three']);
  assert.equal(codex.of('thread/start').length, 1);
});

test('a saved thread is resumed; one that cannot be is replaced by a new thread', async () => {
  const a = session({ resume: 'th-old' });
  a.s.send('continue');
  await tick();
  assert.equal(a.codex.of('thread/resume')[0].params.threadId, 'th-old');
  assert.equal(a.codex.of('thread/start').length, 0);
  assert.equal(a.s.sessionId, 'th-old');

  const b = session({ resume: 'th-gone' });
  b.codex.failResume = true;
  b.s.send('continue');
  await tick();
  assert.equal(b.codex.of('thread/start').length, 1);
  assert.equal(b.s.sessionId, 'th-new');
  assert.ok(b.log.includes('init th-new'));
});

test('a failed turn ends as an error with Codex\'s message', async () => {
  const { s, codex, ends, log } = session();
  s.send('go');
  await tick();
  codex.say('th-new', 'error', { error: { message: 'The model is not supported.', codexErrorInfo: 'modelNotFound' }, willRetry: false });
  codex.say('th-new', 'turn/completed', { turn: { status: 'failed', error: { message: 'The model is not supported.', codexErrorInfo: 'modelNotFound' } } });
  assert.deepEqual(ends[0], { text: 'The model is not supported.', isError: true, internal: false, queued: false, background: false });
  assert.equal(log.at(-1), 'status error The model is not supported.');
});

test('a turn the usage limit stops is not an error: the owner hears the limit', async () => {
  const { s, codex, ends, log } = session();
  s.send('go');
  await tick();
  codex.say('th-new', 'turn/completed', { turn: { status: 'failed', error: { message: 'You have hit your usage limit.', codexErrorInfo: 'usageLimitExceeded' } } });
  assert.equal(ends.length, 0);
  assert.deepEqual(log.slice(-2), ['status idle', 'limited']);
  assert.equal(s.busy, false);
});

test('the app\'s tools answer Codex, and a tool that throws answers as a failure', async () => {
  const { s, codex, log } = session({ tools: [
    { name: 'tell_dispatcher', description: '', inputSchema: {}, run: (a) => `got ${a.message}` },
    { name: 'recall', description: '', inputSchema: {}, run: () => { throw new Error('memory is empty'); } },
  ] });
  s.send('go');
  await tick();
  assert.deepEqual(await codex.ask('th-new', 'item/tool/call', { tool: 'tell_dispatcher', arguments: { message: 'ping' } }), { contentItems: [{ type: 'inputText', text: 'got ping' }], success: true });
  assert.deepEqual(await codex.ask('th-new', 'item/tool/call', { tool: 'recall', arguments: {} }), { contentItems: [{ type: 'inputText', text: 'memory is empty' }], success: false });
  assert.equal((await codex.ask('th-new', 'item/tool/call', { tool: 'nope' }) as any).success, false);
  // The tool's line comes from Codex's own item, not from the call.
  assert.ok(!log.some((l) => l.startsWith('tool ')));
  codex.say('th-new', 'item/started', { item: { type: 'dynamicToolCall', id: 'd1', tool: 'tell_dispatcher' } });
  assert.ok(log.includes('tool tell_dispatcher: tell_dispatcher'));
});

test('a command and a file change are put to the owner, and declined when nobody is there to ask', async () => {
  const asked: any[] = [];
  const { s, codex } = session({ approve: async (req) => { asked.push(req); return req.kind === 'command' ? 'accept' : 'decline'; } });
  s.send('go');
  await tick();
  codex.say('th-new', 'item/started', { item: { type: 'fileChange', id: 'f1', changes: [{ path: '/repo/a.ts' }] } });
  assert.deepEqual(await codex.ask('th-new', 'item/commandExecution/requestApproval', { command: 'git push', cwd: '/repo', reason: 'network' }), { decision: 'accept' });
  assert.deepEqual(await codex.ask('th-new', 'item/fileChange/requestApproval', { itemId: 'f1', reason: null }), { decision: 'decline' });
  assert.deepEqual(asked, [{ kind: 'command', command: 'git push', shell: 'bash', cwd: '/repo', reason: 'network' }, { kind: 'files', files: ['/repo/a.ts'], reason: null }]);
  // The shell Codex wrapped the command in goes with it, so the rules read the line as that shell does.
  await codex.ask('th-new', 'item/commandExecution/requestApproval', { command: String.raw`"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -Command 'git push --fo` + '`' + String.raw`rce'`, cwd: null, reason: null });
  assert.deepEqual(asked[2], { kind: 'command', command: 'git push --fo`rce', shell: 'powershell', cwd: null, reason: null });

  const none = session();
  none.s.send('go');
  await tick();
  assert.deepEqual(await none.codex.ask('th-new', 'item/commandExecution/requestApproval', { command: 'rm -rf x' }), { decision: 'decline' });
});

test('interrupt names the running turn, and close stops listening', async () => {
  const { s, codex } = session();
  s.send('go');
  await tick();
  await s.interrupt();
  assert.deepEqual(codex.of('turn/interrupt')[0].params, { threadId: 'th-new', turnId: 'turn-1' });
  s.close();
  assert.equal(codex.sinks.size, 0);
  assert.throws(() => s.send('more'), /closed/);
});

test('when the Codex process dies the session goes idle and the next message resumes its thread', async () => {
  const { s, codex, log } = session();
  s.send('go');
  await tick();
  codex.sinks.get('th-new')!.lost();
  assert.equal(s.busy, false);
  assert.equal(log.at(-1), 'status idle');
  s.send('again');
  await tick();
  assert.equal(codex.of('thread/resume')[0].params.threadId, 'th-new');
});

test('a compaction reports its start and the size after it', async () => {
  const { s, codex, log } = session();
  s.send('go');
  await tick();
  codex.say('th-new', 'thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 90000 }, last: { totalTokens: 90000 } } });
  codex.say('th-new', 'turn/completed', { turn: { status: 'completed' } });
  s.compact();
  assert.equal(codex.of('thread/compact/start')[0].params.threadId, 'th-new');
  codex.say('th-new', 'thread/compacted', {});
  codex.say('th-new', 'thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 99000 }, last: { totalTokens: 9000 } } });
  assert.deepEqual(log.filter((l) => l.startsWith('compact')), ['compact start', 'compact done']);
  assert.equal(s.contextTokens, 9000);
});

test('items become the tool lines the app shows', () => {
  assert.deepEqual(itemTool({ type: 'commandExecution', command: 'git status' }), { name: 'Bash', summary: '$ git status' });
  assert.deepEqual(itemTool({ type: 'fileChange', changes: [{ path: 'a/1.ts' }, { path: 'a/2.ts' }, { path: 'a/3.ts' }, { path: 'a/4.ts' }] }), { name: 'Edit', summary: 'Edit 1.ts, 2.ts, 3.ts +1' });
  assert.deepEqual(itemTool({ type: 'webSearch', query: 'electron asar' }), { name: 'WebSearch', summary: 'WebSearch electron asar' });
  assert.equal(itemTool({ type: 'agentMessage', text: 'hi' }), null);
  assert.equal(itemTool({ type: 'reasoning' }), null);
});

test('token totals are counted without a price, cached input apart', () => {
  assert.deepEqual(usageSpend({ inputTokens: 34847, cachedInputTokens: 17152, outputTokens: 80 }), { costUsd: 0, input: 17695, output: 80, cacheRead: 17152, cacheWrite: 0 });
  assert.deepEqual(usageSpend(null), { costUsd: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test('only a used-up allowance counts as a usage limit', () => {
  assert.equal(isUsageLimit('usageLimitExceeded'), true);
  assert.equal(isUsageLimit('rateLimitExceeded'), false);
  assert.equal(isUsageLimit({ httpConnectionFailed: { httpStatusCode: 500 } }), false);
  assert.equal(isUsageLimit(null), false);
});

test('usage windows are listed shortest first, whatever the plan has', () => {
  // A free plan: one 30-day window.
  assert.deepEqual(limitWindows({ primary: { usedPercent: 0, windowDurationMins: 43200, resetsAt: 1797903443 }, secondary: null }), [{ utilization: 0, minutes: 43200, resetsAt: '2026-12-22T01:37:23.000Z' }]);
  // A paid plan: weekly and 5-hour, in either order.
  assert.deepEqual(limitWindows({ primary: { usedPercent: 71.4, windowDurationMins: 10080, resetsAt: null }, secondary: { usedPercent: 12, windowDurationMins: 300, resetsAt: null } }).map((w) => [w.minutes, w.utilization]), [[300, 12], [10080, 71]]);
  assert.deepEqual(limitWindows(null), []);
});

test('a command is shown without the shell Codex wraps it in', () => {
  assert.equal(plainCommand(String.raw`"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -Command 'git --version'`), 'git --version');
  assert.equal(plainCommand('bash -lc "npm test -- --watch=false"'), 'npm test -- --watch=false');
  assert.equal(plainCommand("/bin/zsh -lc 'ls -la'"), 'ls -la');
  assert.equal(plainCommand('git status'), 'git status');
  // The shell that wrapper starts is the one whose rules read the command.
  assert.equal(commandShell(String.raw`"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -Command 'git --version'`), 'powershell');
  assert.equal(commandShell(String.raw`"C:\Program Files\PowerShell\7\pwsh.exe" -NoProfile -Command "git status"`), 'powershell');
  assert.equal(commandShell('pwsh -c "git status"'), 'powershell');
  assert.equal(commandShell('bash -lc "npm test"'), 'bash');
  assert.equal(commandShell('git status'), 'bash');
  assert.equal(commandShell('echo "run powershell -Command x"'), 'bash');
  assert.deepEqual(itemTool({ type: 'commandExecution', command: String.raw`"C:\x\powershell.exe" -Command 'git status'` }), { name: 'Bash', summary: '$ git status' });
});
