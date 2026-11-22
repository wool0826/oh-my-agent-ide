import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentSession, LIMIT_RE } from '../src/main/agents/session';
import { accounts } from '../src/main/accounts';
import { loadSettings } from '../src/main/settings';

// How a session tells a usage limit from a turn that only mentions one, and what Stop does to input sent after the
// stopped turn. Two accounts, so a limit would move the session to the other one. No Claude Code process is started.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-session-'));
process.env.OMA_DATA_DIR = tmp;
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({
  home: path.join(tmp, 'home'), language: 'en', claudeRules: false, claudeMemory: false, selfReview: false,
  accounts: [{ id: 'a1', label: 'One', kind: 'login', plan: 'team' }, { id: 'a2', label: 'Two', kind: 'login', plan: 'team' }],
}));

/** Every start of a session, with what it was sent. */
let starts: { account: string | null; sent: string[] }[] = [];
AgentSession.prototype.start = function () {
  const run = { account: this.cfg.accountId, sent: [] as string[] };
  starts.push(run);
  Object.assign(this, { input: { push: (m: any) => run.sent.push(m.message.content), close() {} }, q: { close() {}, interrupt: async () => {} } });
  this.ev.onAccount?.(this.cfg.accountId);
};

const feed = (s: unknown, m: Record<string, unknown>) => (s as { handle(m: unknown): void }).handle(m);
const say = (text: string, over: Record<string, unknown> = {}) => ({
  type: 'assistant', parent_tool_use_id: null,
  message: { model: 'claude-opus-5-5', content: [{ type: 'text', text }], usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5 } },
  ...over,
});
const result = (over: Record<string, unknown> = {}) => ({ type: 'result', subtype: 'success', is_error: false, result: '', ...over });
const limit = (id: string, on: boolean) => {
  loadSettings().accounts.find((a) => a.id === id)!.limitedUntil = on ? new Date(Date.now() + 3600_000).toISOString() : null;
};
const tick = () => new Promise((r) => setImmediate(r));

function open() {
  const ends: { text: string; isError: boolean; queued?: boolean }[] = [];
  const statuses: string[] = [];
  let limited = 0;
  const s = new AgentSession({ label: 'S', model: 'claude-opus-5-5', cwd: tmp, systemAppend: '', accountId: 'a1', resume: 'sid' }, {
    onTurnEnd: (r) => ends.push(r),
    onStatus: (st) => statuses.push(st),
    onLimited: () => { limited += 1; },
  });
  s.start();
  return { s, ends, statuses, limited: () => limited };
}

beforeEach(() => {
  starts = [];
  limit('a1', false);
  limit('a2', false);
});

test('the limit pattern matches what Claude Code says about a limit, and 429 only as a whole number', () => {
  for (const text of ["You've hit your 5-hour limit · resets 3pm", 'Claude AI usage limit reached|1760000000', 'API Error: 429 {"type":"rate_limit_error"}']) {
    assert.ok(LIMIT_RE.test(text), text);
  }
  for (const text of ['Listening on port 14290.', 'Moved 4290 rows.']) assert.ok(!LIMIT_RE.test(text), text);
});

test('a failed turn whose assistant only mentions a limit does not hold the account or move the session', () => {
  const { s, ends, limited } = open();
  s.send('Fix the retry loop.');
  feed(s, say('Fixed the retry loop from issue #429 and added a rate limiter test; the usage limit reached check stays.'));
  feed(s, result({ subtype: 'error_during_execution', is_error: true, errors: ['Tool execution failed'] }));
  assert.ok(accounts.isFree('a1'));
  assert.equal(starts.length, 1);
  assert.equal(limited(), 0);
  assert.deepEqual(ends.map((e) => e.isError), [true]);
});

test('a turn the user stopped is never taken for a limit', async () => {
  const { s, ends } = open();
  s.send('Go.');
  feed(s, say('Hit the rate limit of the test server.'));
  await s.interrupt();
  feed(s, result({ is_error: true, result: 'usage limit reached' }));
  assert.ok(accounts.isFree('a1'));
  assert.equal(starts.length, 1);
  assert.equal(ends.length, 1);
});

test('a limit Claude Code reports still moves the session to another account', () => {
  for (const [msg, res] of [
    [say('Claude AI usage limit reached', { error: 'rate_limit' }), result({ is_error: true, result: 'Claude AI usage limit reached' })],
    [say('Working.'), result({ is_error: true, result: 'API Error', api_error_status: 429 })],
  ] as const) {
    starts = [];
    limit('a1', false);
    const { s, ends } = open();
    s.send('Go.');
    feed(s, msg);
    feed(s, res);
    assert.ok(!accounts.isFree('a1'));
    assert.equal(s.accountId, 'a2');
    assert.equal(starts.length, 2);
    assert.match(starts[1].sent[0], /resumed on another account/);
    assert.equal(ends.length, 0);
  }
});

test('Stop drops input queued behind the stopped turn, so no next turn starts; what was sent after Stop still goes out', async () => {
  const { s, ends, statuses } = open();
  s.send('First.');
  s.send('Second, queued.');
  await s.interrupt();
  s.send('Sent after Stop.');
  feed(s, result({ subtype: 'error_during_execution', is_error: true, errors: [], queued_turn_count: 2 }));
  // The stopped turn ends the work: nothing queued behind it follows.
  assert.deepEqual(ends.map((e) => [e.isError, e.queued]), [[true, false]]);
  assert.equal(statuses.at(-1), 'error');
  await tick();
  // A new process resumes the conversation with only the message sent after Stop.
  assert.equal(starts.length, 2);
  assert.deepEqual(starts[1].sent, ['Sent after Stop.']);
  assert.equal(s.busy, true);
});

test('without Stop, input queued behind a turn still follows it', () => {
  const { s, ends } = open();
  s.send('First.');
  s.send('Second, queued.');
  feed(s, result({ result: 'Done.', queued_turn_count: 1 }));
  assert.deepEqual(ends.map((e) => e.queued), [true]);
  assert.equal(starts.length, 1);
  assert.equal(s.busy, true);
});
