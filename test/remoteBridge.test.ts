import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Outbox } from '../src/main/remote/bridge';
import { TelegramError } from '../src/main/remote/telegramApi';
import { TelegramLink, type LinkCrypt, type LinkStore } from '../src/main/remote/telegramLink';
import { cleanTelegram, type TelegramStored } from '../src/shared/remote';
import { decisionNews, type RemoteNews } from '../src/shared/remoteNotice';
import { startTelegramStub, type TelegramStub } from './e2e/telegram-stub.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-bridge-'));
process.env.OMA_DATA_DIR = tmp;
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ home: path.join(tmp, 'home'), language: 'en', accounts: [] }));

const crypt: LinkCrypt = { available: () => true, encrypt: (s) => `enc:${Buffer.from(s).toString('base64')}`, decrypt: (s) => Buffer.from(s.slice(4), 'base64').toString() };

const result = (n = 1, o: Partial<Extract<RemoteNews, { type: 'result' }>> = {}): RemoteNews =>
  ({ type: 'result', task: `T-${n}`, who: 'W-01', title: `Task ${n}`, summary: `Did ${n}.\n\`\`\`\nsecret code\n\`\`\``, ok: true, code: true, prUrl: `https://github.com/o/r/pull/${n}`, ...o });

async function withOutbox(fn: (s: TelegramStub, box: Outbox, link: TelegramLink, cfg: { quiet: boolean }) => Promise<void>, stored: Partial<TelegramStored> = {}) {
  const s = await startTelegramStub();
  const cell = { tokenEnc: crypt.encrypt(s.token), cfg: { ...cleanTelegram(null), enabled: true, botId: 123456789, botName: 'stub_bot', ownerId: 42, ownerName: 'Owner', ...stored } };
  const store: LinkStore = { load: () => ({ tokenEnc: cell.tokenEnc, cfg: { ...cell.cfg } }), save: (tokenEnc, c) => { cell.tokenEnc = tokenEnc; cell.cfg = { ...c }; } };
  const link = new TelegramLink(store, crypt, s.url, 1);
  const cfg = { quiet: false };
  const box = new Outbox(link, { quiet: () => cfg.quiet, gapMs: 5, backoff: () => 5, tries: 3 });
  try { await fn(s, box, link, cfg); } finally { await box.idle(); await link.halt(); await s.close(); }
}

test('remoteBridge: nothing is queued while Telegram is off or unpaired', () => withOutbox(async (s, box, link) => {
  await link.setEnabled(false);
  assert.equal(box.tell(result()), false);
  await link.setEnabled(true);
  await link.disconnect();
  assert.equal(box.tell(result()), false);
  assert.equal(s.state.sent.length, 0);
}));

test('remoteBridge: a result goes to the owner as plain text with its PR link and no code', () => withOutbox(async (s, box) => {
  assert.equal(box.tell(result()), true);
  await box.idle();
  assert.equal(s.state.sent.length, 1);
  const m = s.state.sent[0];
  assert.equal(m.chat_id, 42);
  assert.match(m.text, /^W-01 done · PR #1\n\nTask 1\n\nDid 1\./);
  assert.match(m.text, /https:\/\/github\.com\/o\/r\/pull\/1$/);
  assert.doesNotMatch(m.text, /secret code/);
  assert.equal(m.disable_notification, undefined);
}));

test('remoteBridge: a kind switched off is not sent, and title only leaves out the summary and links', () => withOutbox(async (s, box, link) => {
  link.setPrefs({ events: { results: false } });
  assert.equal(box.tell(result()), false);
  link.setPrefs({ events: { results: true }, level: 'title' });
  box.tell(result(2));
  await box.idle();
  assert.equal(s.state.sent.length, 1);
  assert.equal(s.state.sent[0].text, 'W-01 done · PR #2\n\nTask 2');
}));

test('remoteBridge: do-not-disturb hours and the rest of a burst come without a sound', () => withOutbox(async (s, box, _link, cfg) => {
  cfg.quiet = true;
  box.tell({ type: 'pr', task: 'T-9', title: 'Nine', merged: true, prUrl: null });
  await box.idle();
  cfg.quiet = false;
  box.tell(result(1));
  await box.idle();
  box.tell(result(2));
  await box.idle();
  assert.deepEqual(s.state.sent.map((m) => m.disable_notification ?? false), [true, false, true]);
}));

test('remoteBridge: the same news twice is sent once; news of one burst still waiting joins one message', () => withOutbox(async (s, box) => {
  s.failNext('sendMessage', 500, 'Internal Server Error');
  box.tell(result(1));
  box.tell(result(1));
  box.tell({ type: 'error', text: 'Disk full' });
  box.tell({ type: 'error', text: 'Network down' });
  await box.idle();
  assert.equal(s.state.sent.filter((m) => /Task 1/.test(m.text)).length, 1);
  const errors = s.state.sent.filter((m) => /^Error/.test(m.text));
  assert.equal(errors.length, 1);
  assert.match(errors[0].text, /Disk full[\s\S]*Network down/);
}));

test('remoteBridge: a 429 waits its retry_after, then the message goes', () => withOutbox(async (s, box) => {
  s.failNext('sendMessage', 429, 'Too Many Requests: retry after 1', { parameters: { retry_after: 1 } });
  const t0 = Date.now();
  box.tell(result());
  await box.idle();
  assert.equal(s.state.sent.length, 1);
  assert.ok(Date.now() - t0 >= 950, 'waited about a second');
}));

test('remoteBridge: a message that keeps failing is dropped after its tries and the next one goes', () => withOutbox(async (s, box) => {
  s.failNext('sendMessage', 502, 'Bad Gateway', {}, 3);
  box.tell(result(1));
  box.tell({ type: 'pr', task: 'T-2', title: 'Two', merged: false, prUrl: null });
  await box.idle();
  assert.deepEqual(s.state.sent.map((m) => m.text.split('\n')[0]), ['PR closed']);
  box.tell(result(1));
  await box.idle();
  assert.equal(s.state.sent.length, 2, 'the dropped news is not a repeat');
}));

/** A channel without Telegram: `fail` decides what each send does, `sent` keeps what went. */
function fakeChannel(fail: (n: number) => Error | null = () => null) {
  const ch = { ready: true, sent: [] as string[], calls: 0, prefs: () => cleanTelegram(null).prefs,
    async send(text: string) { const e = fail(ch.calls++); if (e) throw e; ch.sent.push(text); return ch.sent.length; },
    async edit() {} };
  return ch;
}

test('remoteBridge: news told just as the queue runs dry still goes', async () => {
  const ch = fakeChannel();
  const box = new Outbox(ch, { quiet: () => false, gapMs: 0 });
  for (let depth = 0; depth < 12; depth++) {
    box.tell({ type: 'pr', task: `T-a${depth}`, title: 'A', merged: true, prUrl: null });
    let p: Promise<void> = Promise.resolve();
    for (let i = 0; i < depth; i++) p = p.then(() => {});
    void p.then(() => box.tell({ type: 'error', text: `late ${depth}` }));
    await box.idle();
  }
  assert.equal(ch.sent.filter((x) => /late/.test(x)).length, 12);
});

test('remoteBridge: nothing more goes once the channel is turned off during the gap', async () => {
  const ch = fakeChannel();
  const box = new Outbox(ch, { quiet: () => false, gapMs: 100 });
  box.tell({ type: 'pr', task: 'T-1', title: 'One', merged: true, prUrl: null });
  box.tell({ type: 'error', text: 'Two' });
  while (!ch.sent.length) await new Promise((r) => setTimeout(r, 5));
  ch.ready = false;
  await box.idle();
  assert.equal(ch.sent.length, 1);
});

test('remoteBridge: a message Telegram keeps refusing for speed is dropped in the end', async () => {
  const ch = fakeChannel((n) => (n < 11 ? new TelegramError('sendMessage', 'rate', 429, 'Too Many Requests', 0) : null));
  const box = new Outbox(ch, { quiet: () => false, gapMs: 0 });
  box.tell({ type: 'pr', task: 'T-1', title: 'One', merged: true, prUrl: null });
  box.tell({ type: 'error', text: 'Two' });
  await box.idle();
  assert.equal(ch.calls, 12);
  assert.deepEqual(ch.sent.map((x) => x.split('\n')[0]), ['Error']);
});

test('remoteBridge: a revoked token empties the queue and marks the link invalid', () => withOutbox(async (s, box, link) => {
  s.revoke();
  box.tell(result(1));
  box.tell({ type: 'pr', task: 'T-2', title: 'Two', merged: true, prUrl: null });
  await box.idle();
  assert.equal(s.state.sent.length, 0);
  assert.equal(box.queue.size, 0);
  assert.equal(link.view().status, 'invalid');
  assert.equal(box.tell(result(3)), false);
}));

test('remoteBridge: a burst too long for one message goes in several of at most 4096 characters', () => withOutbox(async (s, box) => {
  s.failNext('sendMessage', 500, 'Internal Server Error');
  for (let i = 1; i <= 9; i++) box.tell(result(i, { summary: 'x'.repeat(790), prUrl: null }));
  await box.idle();
  assert.ok(s.state.sent.length >= 3);
  assert.ok(s.state.sent.every((m) => m.text.length <= 4096));
  const all = s.state.sent.map((m) => m.text).join('\n');
  for (let i = 1; i <= 9; i++) assert.equal(all.split(`Task ${i}\n`).length - 1, 1, `Task ${i} once`);
}));

test('remoteBridge: a Dispatcher answer goes without its code, and a reply to it on the phone finds its chat item', () => withOutbox(async (s, box) => {
  assert.equal(box.tell({ type: 'reply', id: 'c-1', text: 'Gave it to W-01.\n```\nrm -rf /\n```' }), true);
  await box.idle();
  assert.equal(s.state.sent.length, 1);
  assert.equal(s.state.sent[0].text, 'Gave it to W-01.\n…');
  assert.equal(box.sent.get(s.state.sent[0].message_id), 'c-1');
}));

test('remoteBridge: a result is remembered by its task, so a reply goes into the report\'s thread', () => withOutbox(async (s, box) => {
  box.tell(result(7));
  await box.idle();
  assert.equal(box.sent.get(s.state.sent[0].message_id), 'T-7');
}));

test('remoteBridge: the bot\'s own answer goes as a reply to the phone\'s message, whatever news is switched off', () => withOutbox(async (s, box, link) => {
  link.setPrefs({ events: { decisions: false, results: false, prs: false, errors: false, replies: false } });
  assert.equal(box.answer('STATUS', 55), true);
  assert.equal(box.answer('STATUS', 56), true, 'the same words twice are two answers');
  await box.idle();
  assert.deepEqual(s.state.sent.map((m) => [m.text, (m.reply_parameters as { message_id: number }).message_id]), [['STATUS', 55], ['STATUS', 56]]);
}));

test('remoteBridge: Dispatcher answers are switched off on their own', () => withOutbox(async (s, box, link) => {
  link.setPrefs({ events: { replies: false } });
  assert.equal(box.tell({ type: 'reply', id: 'c-2', text: 'hi' }), false);
  assert.equal(box.tell(result(1)), true);
  await box.idle();
  assert.equal(s.state.sent.length, 1);
}));

const asked = (o: { id?: string; source?: 'question' | 'plan' | 'permission'; who?: string; code?: string | null } = {}): RemoteNews => decisionNews(
  { id: o.id ?? 'abc', source: o.source ?? 'question', workerId: o.who ?? 'W-01', title: 'Which database?', detail: '', options: [{ label: 'Postgres' }, { label: 'SQLite' }], code: o.code ?? null },
  o.source === 'permission' ? [] : o.source === 'plan' ? [{ label: 'Approve plan', answer: 'allow' }, { label: 'Deny', answer: 'deny' }] : [{ label: 'Postgres', answer: 'Postgres' }, { label: 'SQLite', answer: 'SQLite' }],
);
const keys = (m: { [k: string]: unknown }) => (m.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] } | undefined)?.inline_keyboard.flat().map((b) => b.callback_data) ?? [];

test('remoteBridge: a question goes with its answers as buttons; answered, they come off and the answer is added', () => withOutbox(async (s, box) => {
  box.tell(asked());
  await box.idle();
  assert.deepEqual(keys(s.state.sent[0]), ['d:abc:0', 'd:abc:1']);
  box.settle('abc', 'Postgres');
  await box.idle();
  const e = s.state.edits[0];
  assert.equal(e.method, 'editMessageText');
  assert.equal(e.message_id, s.state.sent[0].message_id);
  assert.match(e.text!, /Which database\?[\s\S]*\n\n→ Postgres$/);
  assert.deepEqual(e.reply_markup, { inline_keyboard: [] });
  box.settle('abc', 'Postgres');
  await box.idle();
  assert.equal(s.state.edits.length, 1, 'settled once');
}));

test('remoteBridge: two decisions with buttons from one Worker stay two messages', () => withOutbox(async (s, box) => {
  box.tell({ type: 'error', text: 'first' });
  box.tell(asked({ id: 'one' }));
  box.tell(asked({ id: 'two' }));
  await box.idle();
  assert.deepEqual(s.state.sent.slice(1).map(keys), [['d:one:0', 'd:one:1'], ['d:two:0', 'd:two:1']]);
}));

test('remoteBridge: a decision settled before its message went is not sent', () => withOutbox(async (s, box) => {
  box.tell({ type: 'error', text: 'first' });
  box.tell(asked({ id: 'gone' }));
  box.settle('gone', null);
  await box.idle();
  assert.equal(s.state.sent.length, 1);
  assert.equal(s.state.edits.length, 0);
}));

test('remoteBridge: a withdrawn decision says so in place of its buttons', () => withOutbox(async (s, box) => {
  box.tell(asked());
  await box.idle();
  box.settle('abc', null);
  await box.idle();
  assert.match(s.state.edits[0].text!, /\n\nWithdrawn$/);
}));

test('remoteBridge: a plan goes with its text and buttons at the summary level, its title only otherwise', () => withOutbox(async (s, box, link) => {
  box.tell(asked({ id: 'p1', source: 'plan', code: 'WHAT: add a cache\n1. Write it\n2. Test it' }));
  await box.idle();
  assert.match(s.state.sent[0].text, /Write it/);
  assert.deepEqual(keys(s.state.sent[0]), ['d:p1:0', 'd:p1:1']);
  link.setPrefs({ level: 'title' });
  box.tell(asked({ id: 'p2', source: 'plan', code: 'WHAT: other\n1. Secret step' }));
  await box.idle();
  assert.doesNotMatch(s.state.sent[1].text, /Secret step/);
  assert.deepEqual(keys(s.state.sent[1]), []);
}));

test('remoteBridge: with answers off a decision goes without buttons; a permission never has any', () => withOutbox(async (s, box, link) => {
  box.tell(asked({ id: 'perm', source: 'permission' }));
  link.setPrefs({ buttons: false });
  box.tell(asked({ id: 'q', who: 'W-02' }));
  await box.idle();
  assert.deepEqual(s.state.sent.map(keys), [[], []]);
}));
