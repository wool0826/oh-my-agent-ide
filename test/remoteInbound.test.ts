import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Inbound, type HeldMessage, type InboundDeps } from '../src/main/remote/inbound';
import type { TgUpdate } from '../src/shared/remote';
import type { Decision } from '../src/shared/types';

type Dec = Pick<Decision, 'id' | 'source' | 'options' | 'status'>;

const NOW = 1_800_000_000_000;

function setup(o: { requests?: boolean; buttons?: boolean; held?: boolean; busy?: boolean; refs?: Record<number, string>; waiting?: HeldMessage[]; fail?: boolean; decisions?: Dec[] } = {}) {
  const seen = new Set<number>();
  const kept = { list: o.waiting ?? [] };
  const log = {
    sent: [] as { text: string; replyTo: string | null }[], answers: [] as { text: string; replyTo?: number; buttons?: unknown }[], flushes: 0, locked: 0, stops: 0,
    decided: [] as [string, string][], acks: [] as [string, string | undefined][], cleared: [] as number[],
  };
  let requests = o.requests ?? true;
  let buttons = o.buttons ?? true;
  const deps: InboundDeps = {
    say: (k, v) => (v ? `${k}(${Object.values(v).join(',')})` : k),
    now: () => NOW,
    toDispatcher: (text, replyTo) => {
      if (o.fail) throw new Error('no session');
      log.sent.push({ text, replyTo });
      return { held: !!o.held };
    },
    stop: async () => { log.stops++; return !!o.busy; },
    lock: () => { log.locked++; requests = false; buttons = false; },
    requests: () => requests,
    buttons: () => buttons,
    answer: (text, replyTo, b) => { log.answers.push({ text, replyTo, ...(b ? { buttons: b } : {}) }); },
    decision: (id) => o.decisions?.find((d) => d.id === id) ?? null,
    answerDecision: (id, ans) => { log.decided.push([id, ans]); },
    ack: (id, text) => { log.acks.push([id, text]); },
    clearButtons: (id) => { log.cleared.push(id); },
    refOf: (id) => (id === undefined ? null : o.refs?.[id] ?? null),
    statusText: () => 'STATUS',
    inboxText: () => 'INBOX',
    seen: { has: (id) => seen.has(id), add: (id) => { seen.add(id); } },
    waiting: { load: () => kept.list, save: (l) => { kept.list = [...l]; } },
    flush: () => { log.flushes++; },
  };
  return { inbound: new Inbound(deps), log, kept };
}

let next = 1;
const press = (data: string, messageId = 500): TgUpdate => ({
  update_id: next++,
  callback_query: { id: `cb${next}`, from: { id: 42 }, message: { message_id: messageId, chat: { id: 42, type: 'private' } }, data },
});
const question: Dec = { id: 'q1', source: 'question', status: 'pending', options: [{ label: 'Postgres' }, { label: 'SQLite' }] };
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

test('remoteInbound: past twenty a minute a message or a command is turned away, said once; /lock still goes', async () => {
  const { inbound, log } = setup();
  for (let i = 0; i < 20; i++) await inbound.handle(msg(`m${i}`));
  await inbound.handle(msg('m20'));
  await inbound.handle(msg('/status'));
  await inbound.handle(msg('/lock'));
  assert.equal(log.sent.length, 20);
  assert.deepEqual(log.answers.map((a) => a.text), ['tg.r.slow', 'tg.r.lockedNow']);
});

test('remoteInbound: words the Dispatcher could not take are said to have failed', async () => {
  const { inbound, log } = setup({ fail: true });
  await inbound.handle(msg('go'));
  assert.deepEqual(log.answers.map((a) => a.text), ['tg.r.failed']);
  assert.equal(log.flushes, 1);
});

test('remoteInbound: waiting messages are kept with the state and still there after a restart', async () => {
  const old = Math.floor(NOW / 1000) - 3600;
  const a = setup();
  await a.inbound.handle(msg('while off', { date: old }));
  assert.deepEqual(a.kept.list, [{ text: 'while off', replyTo: null }]);
  const b = setup({ waiting: a.kept.list });
  assert.equal(b.inbound.held, 1);
  await b.inbound.handle(msg('/run'));
  assert.deepEqual(b.log.sent, [{ text: 'while off', replyTo: null }]);
  assert.deepEqual(b.kept.list, []);
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

test('remoteInbound: a press on a decision button answers it as the user and ends the spinner with its label', async () => {
  const { inbound, log } = setup({ decisions: [question] });
  const u = press('d:q1:1');
  await inbound.handle(u);
  await inbound.handle(u);
  assert.deepEqual(log.decided, [['q1', 'SQLite']]);
  assert.deepEqual(log.acks, [[u.callback_query!.id, 'SQLite']]);
  assert.equal(log.flushes, 1);
});

test('remoteInbound: a press on a decision settled or gone says so and takes the buttons off', async () => {
  const { inbound, log } = setup({ decisions: [{ ...question, status: 'answered' }] });
  await inbound.handle(press('d:q1:0', 501));
  await inbound.handle(press('d:zz:0', 502));
  await inbound.handle(press('d:q1:9', 503));
  assert.deepEqual(log.decided, []);
  assert.deepEqual(log.acks.map((a) => a[1]), ['tg.r.handled', 'tg.r.handled', 'tg.r.handled']);
  assert.deepEqual(log.cleared, [501, 502, 503]);
});

test('remoteInbound: with answers off a press answers nothing; a button the app did not send only ends the spinner', async () => {
  const { inbound, log } = setup({ decisions: [question], buttons: false });
  await inbound.handle(press('d:q1:0'));
  await inbound.handle(press('rm -rf'));
  assert.deepEqual(log.decided, []);
  assert.deepEqual(log.acks.map((a) => a[1]), ['tg.r.answersOff', undefined]);
});

test('remoteInbound: a reply to a waiting question answers it, even with requests off; to a permission it is refused', async () => {
  const perm: Dec = { id: 'p1', source: 'permission', status: 'pending', options: [] };
  const { inbound, log } = setup({ decisions: [question, perm], requests: false, refs: { 7: 'd:q1', 8: 'd:p1' } });
  await inbound.handle(msg('MySQL, please', { reply: 7 }));
  await inbound.handle(msg('yes', { reply: 8 }));
  assert.deepEqual(log.decided, [['q1', 'MySQL, please']]);
  assert.deepEqual(log.answers.map((a) => a.text), ['tg.r.desktopOnly']);
  assert.deepEqual(log.sent, []);
});

test('remoteInbound: a forwarded reply never answers a decision', async () => {
  const { inbound, log } = setup({ decisions: [question], refs: { 7: 'd:q1' } });
  await inbound.handle(msg('Postgres', { reply: 7, forwarded: true }));
  assert.deepEqual(log.decided, []);
  assert.equal(log.sent.length, 1);
});

test('remoteInbound: held messages are asked about with Send and Drop buttons, and Send sends them', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { inbound, log } = setup();
  await inbound.handle(msg('while off', { date: Math.floor(NOW / 1000) - 3600 }));
  t.mock.timers.tick(2_000);
  assert.deepEqual(log.answers.at(-1), { text: 'tg.r.stale(1)', replyTo: undefined, buttons: [[{ text: 'tg.b.run', data: 'h:run' }, { text: 'tg.b.drop', data: 'h:drop' }]] });
  await inbound.handle(press('h:run', 600));
  assert.deepEqual(log.sent, [{ text: 'while off', replyTo: null }]);
  assert.deepEqual(log.cleared, [600]);
  assert.equal(log.answers.at(-1)!.text, 'tg.r.ran(1)');
});

test('remoteInbound: /lock turns answers off as well', async () => {
  const { inbound, log } = setup({ decisions: [question], requests: false });
  await inbound.handle(msg('/lock'));
  await inbound.handle(press('d:q1:0'));
  assert.equal(log.locked, 1);
  assert.deepEqual(log.decided, []);
});
