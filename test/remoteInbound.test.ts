import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Inbound, type InboundDeps } from '../src/main/remote/inbound';
import type { TgUpdate } from '../src/shared/remote';

const NOW = 1_800_000_000_000;

function setup(o: { requests?: boolean; held?: boolean; busy?: boolean; refs?: Record<number, string> } = {}) {
  const seen = new Set<number>();
  const log = { sent: [] as { text: string; replyTo: string | null }[], answers: [] as { text: string; replyTo?: number }[], flushes: 0, locked: 0, stops: 0 };
  let requests = o.requests ?? true;
  const deps: InboundDeps = {
    say: (k, v) => (v ? `${k}(${Object.values(v).join(',')})` : k),
    now: () => NOW,
    toDispatcher: (text, replyTo) => { log.sent.push({ text, replyTo }); return { held: !!o.held }; },
    stop: async () => { log.stops++; return !!o.busy; },
    lock: () => { log.locked++; requests = false; },
    requests: () => requests,
    answer: (text, replyTo) => { log.answers.push({ text, replyTo }); },
    refOf: (id) => (id === undefined ? null : o.refs?.[id] ?? null),
    statusText: () => 'STATUS',
    inboxText: () => 'INBOX',
    seen: { has: (id) => seen.has(id), add: (id) => { seen.add(id); } },
    flush: () => { log.flushes++; },
  };
  return { inbound: new Inbound(deps), log };
}

let next = 1;
const msg = (text: string | undefined, o: { date?: number; reply?: number; forwarded?: boolean } = {}): TgUpdate => ({
  update_id: next++,
  message: {
    message_id: 100 + next, date: o.date ?? Math.floor(NOW / 1000), chat: { id: 42, type: 'private' }, from: { id: 42 }, text,
    ...(o.reply ? { reply_to_message: { message_id: o.reply } } : {}),
    ...(o.forwarded ? { forward_origin: { type: 'user' } } : {}),
  },
});

test('remoteInbound: words go to the Dispatcher once, and the state is written before the next poll', async () => {
  const { inbound, log } = setup();
  const u = msg('fix the login bug');
  await inbound.handle(u);
  await inbound.handle(u);
  assert.deepEqual(log.sent, [{ text: 'fix the login bug', replyTo: null }]);
  assert.equal(log.flushes, 1);
  assert.deepEqual(log.answers, []);
});

test('remoteInbound: a reply to a result goes into its thread; a reply to a decision is a plain message', async () => {
  const { inbound, log } = setup({ refs: { 7: 'T-0007', 8: 'd:abc' } });
  await inbound.handle(msg('and the tests?', { reply: 7 }));
  await inbound.handle(msg('yes', { reply: 8 }));
  await inbound.handle(msg('hm', { reply: 9 }));
  assert.deepEqual(log.sent.map((x) => x.replyTo), ['T-0007', null, null]);
});

test('remoteInbound: with requests off, words and /stop are turned away with a reply; /status still answers', async () => {
  const { inbound, log } = setup({ requests: false });
  const u = msg('do it');
  await inbound.handle(u);
  await inbound.handle(msg('/stop'));
  await inbound.handle(msg('/status'));
  assert.deepEqual(log.sent, []);
  assert.equal(log.stops, 0);
  assert.deepEqual(log.answers.map((a) => a.text), ['tg.r.locked', 'tg.r.locked', 'STATUS']);
  assert.equal(log.answers[0].replyTo, u.message!.message_id);
});

test('remoteInbound: /lock turns requests off, and words after it are turned away', async () => {
  const { inbound, log } = setup();
  await inbound.handle(msg('/lock'));
  await inbound.handle(msg('/lock'));
  await inbound.handle(msg('hello'));
  assert.equal(log.locked, 1);
  assert.deepEqual(log.answers.map((a) => a.text), ['tg.r.lockedNow', 'tg.r.lockedNow', 'tg.r.locked']);
  assert.deepEqual(log.sent, []);
});

test('remoteInbound: /stop says whether a turn was stopped', async () => {
  const a = setup({ busy: true });
  await a.inbound.handle(msg('/stop'));
  const b = setup({ busy: false });
  await b.inbound.handle(msg('/stop'));
  assert.deepEqual([a.log.answers[0].text, b.log.answers[0].text], ['tg.r.stopped', 'tg.r.idle']);
});

test('remoteInbound: words that wait for a usage limit are said to wait', async () => {
  const { inbound, log } = setup({ held: true });
  await inbound.handle(msg('go'));
  assert.equal(log.sent.length, 1);
  assert.deepEqual(log.answers.map((a) => a.text), ['tg.r.held']);
});

test('remoteInbound: past twenty a minute a message is turned away', async () => {
  const { inbound, log } = setup();
  for (let i = 0; i < 21; i++) await inbound.handle(msg(`m${i}`));
  assert.equal(log.sent.length, 20);
  assert.deepEqual(log.answers.map((a) => a.text), ['tg.r.slow']);
});

test('remoteInbound: messages sent while the app was off wait; /run sends them as one, /drop drops them', async () => {
  const old = Math.floor(NOW / 1000) - 3600;
  const a = setup();
  await a.inbound.handle(msg('first', { date: old }));
  await a.inbound.handle(msg('second', { date: old }));
  assert.equal(a.inbound.held, 2);
  assert.deepEqual(a.log.sent, []);
  await a.inbound.handle(msg('/run'));
  assert.deepEqual(a.log.sent, [{ text: 'first\n\nsecond', replyTo: null }]);
  assert.equal(a.log.answers.at(-1)!.text, 'tg.r.ran(2)');
  await a.inbound.handle(msg('/run'));
  assert.equal(a.log.answers.at(-1)!.text, 'tg.r.noneHeld');

  const b = setup();
  await b.inbound.handle(msg('old', { date: old }));
  await b.inbound.handle(msg('/drop'));
  assert.equal(b.inbound.held, 0);
  assert.deepEqual(b.log.sent, []);
  assert.equal(b.log.answers.at(-1)!.text, 'tg.r.dropped(1)');
});

test('remoteInbound: a voice note or a sticker gets "not supported"; unknown commands get help', async () => {
  const { inbound, log } = setup();
  await inbound.handle(msg(undefined));
  await inbound.handle(msg('/deploy'));
  assert.deepEqual(log.answers.map((a) => a.text), ['tg.r.unsupported', 'tg.r.help']);
  assert.deepEqual(log.sent, []);
});
