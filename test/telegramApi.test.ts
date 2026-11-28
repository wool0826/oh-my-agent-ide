import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramApi, TelegramError, telegramBase } from '../src/main/remote/telegramApi';
import { TelegramPoller, type PollState } from '../src/main/remote/telegram';
import { startTelegramStub, type TelegramStub } from './e2e/telegram-stub.mjs';
import type { TgUpdate } from '../src/shared/remote';

/** Waits for a condition, failing with `what` after a few seconds. */
async function until(ok: () => boolean, what: string, ms = 5_000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise<void>((r) => setImmediate(r));
  }
}

async function withStub(fn: (s: TelegramStub, api: TelegramApi) => Promise<void>) {
  const s = await startTelegramStub();
  try { await fn(s, new TelegramApi(s.token, s.url)); } finally { await s.close(); }
}

const poller = (api: TelegramApi, got: TgUpdate[], states: PollState[], errs: string[] = []) =>
  new TelegramPoller(api, { onUpdate: (u) => { got.push(u); }, onState: (st, e) => { states.push(st); if (e) errs.push(e.message); }, timeoutSec: 1, backoff: () => 5 });

test('telegramApi: the address is api.telegram.org unless OMA_TELEGRAM_API moves it', () => {
  const old = process.env.OMA_TELEGRAM_API;
  delete process.env.OMA_TELEGRAM_API;
  assert.equal(telegramBase(), 'https://api.telegram.org');
  process.env.OMA_TELEGRAM_API = 'http://127.0.0.1:9/';
  assert.equal(telegramBase(), 'http://127.0.0.1:9');
  if (old === undefined) delete process.env.OMA_TELEGRAM_API; else process.env.OMA_TELEGRAM_API = old;
});

test('telegramApi: getMe names the bot', () => withStub(async (s, api) => {
  assert.equal((await api.getMe()).username, 'stub_bot');
}));

test('telegramApi: a message goes as plain text with no link preview, quietly when asked', () => withStub(async (s, api) => {
  const r = await api.sendMessage(42, 'see https://github.com/x/y/pull/1', { silent: true, replyTo: 7 });
  assert.equal(r.message_id, s.state.sent[0].message_id);
  const p = s.state.calls.find((c) => c.method === 'sendMessage')!.params;
  assert.equal(p.chat_id, 42);
  assert.equal(p.parse_mode, undefined);
  assert.deepEqual(p.link_preview_options, { is_disabled: true });
  assert.equal(p.disable_notification, true);
  assert.equal(p.reply_parameters.message_id, 7);
  await api.sendMessage(42, 'loud');
  assert.equal(s.state.sent[1].disable_notification, undefined);
}));

test('telegramApi: a refused token is an auth error, and the token is never in the message', () => withStub(async (s, api) => {
  s.revoke();
  await assert.rejects(api.getMe(), (e: TelegramError) => e.kind === 'auth' && e.code === 401 && !e.message.includes(s.token) && /^getMe: 401/.test(e.message));
}));

test('telegramApi: 429 carries retry_after, 400 is a bad request', () => withStub(async (s, api) => {
  s.failNext('sendMessage', 429, 'Too Many Requests: retry after 3', { parameters: { retry_after: 3 } });
  await assert.rejects(api.sendMessage(1, 'x'), (e: TelegramError) => e.kind === 'rate' && e.retryAfter === 3);
  await assert.rejects(api.sendMessage(1, ''), (e: TelegramError) => e.kind === 'bad' && e.code === 400);
}));

test('telegramApi: a server that is not there is a network error without the address', async () => {
  const api = new TelegramApi('123456789:AAEhBP0av18q1wQ7abcdefghijklmnopqrst', 'http://127.0.0.1:1');
  await assert.rejects(api.getMe({ timeoutMs: 2_000 }), (e: TelegramError) => e.kind === 'network' && !e.message.includes('127.0.0.1') && !e.message.includes('AAEh'));
});

test('telegramApi: an aborted call ends at once as a network error', () => withStub(async (s, api) => {
  const ctl = new AbortController();
  const p = api.getUpdates(null, 30, { signal: ctl.signal });
  await until(() => !!s.state.waiting, 'the stub to hold the poll');
  ctl.abort();
  await assert.rejects(p, (e: TelegramError) => e.kind === 'network' && /aborted/.test(e.message));
}));

test('telegramApi: long polling waits for an update, and the offset confirms the ones before it', () => withStub(async (s, api) => {
  const p = api.getUpdates(null, 5);
  await until(() => !!s.state.waiting, 'the stub to hold the poll');
  const u = s.push(s.user(42, 'hi'));
  assert.deepEqual((await p).map((x) => x.update_id), [u.update_id]);
  assert.equal((await api.getUpdates(null, 0)).length, 1, 'not confirmed yet');
  assert.equal((await api.getUpdates(u.update_id + 1, 0)).length, 0);
}));

test('telegramApi: a second poll ends the first with a conflict', () => withStub(async (s, api) => {
  const first = api.getUpdates(null, 5);
  await until(() => !!s.state.waiting, 'the stub to hold the poll');
  const second = api.getUpdates(null, 1);
  await assert.rejects(first, (e: TelegramError) => e.kind === 'conflict' && e.code === 409);
  assert.deepEqual(await second, []);
}));

test('telegramPoller: updates are handed on once each, in order, and confirmed', () => withStub(async (s, api) => {
  const got: TgUpdate[] = [], states: PollState[] = [];
  const pl = poller(api, got, states);
  pl.start();
  s.push(s.user(42, 'one'));
  s.push(s.user(42, 'two'));
  await until(() => got.length === 2, 'both updates');
  await until(() => s.state.calls.filter((c) => c.method === 'getUpdates').some((c) => c.params.offset === 3), 'the next poll to confirm them');
  await pl.stop();
  assert.deepEqual(got.map((u) => u.message?.text), ['one', 'two']);
  assert.deepEqual(states, ['ok']);
  assert.ok(!pl.running);
}));

test('telegramPoller: a handler that throws does not bring the update back', () => withStub(async (s, api) => {
  const states: PollState[] = [];
  let calls = 0;
  const pl = new TelegramPoller(api, { onUpdate: () => { calls++; throw new Error('boom'); }, onState: (st) => { states.push(st); }, timeoutSec: 1 });
  pl.start();
  s.push(s.user(42, 'x'));
  await until(() => s.state.calls.filter((c) => c.method === 'getUpdates').some((c) => c.params.offset === 2), 'the poll after it');
  await pl.stop();
  assert.equal(calls, 1);
}));

test('telegramPoller: failures retry with a wait, then report ok again', () => withStub(async (s, api) => {
  const got: TgUpdate[] = [], states: PollState[] = [];
  s.failNext('getUpdates', 502, 'Bad Gateway', {}, 2);
  const pl = poller(api, got, states);
  pl.start();
  s.push(s.user(42, 'after'));
  await until(() => got.length === 1, 'the update after the failures');
  await pl.stop();
  assert.deepEqual(states, ['retrying', 'retrying', 'ok']);
}));

test('telegramPoller: 429 waits for retry_after', () => withStub(async (s, api) => {
  const got: TgUpdate[] = [], states: PollState[] = [];
  s.failNext('getUpdates', 429, 'Too Many Requests', { parameters: { retry_after: 1 } });
  const pl = poller(api, got, states);
  const t0 = Date.now();
  pl.start();
  s.push(s.user(42, 'x'));
  await until(() => got.length === 1, 'the update after the wait');
  await pl.stop();
  assert.ok(Date.now() - t0 >= 950, 'waited about a second');
}));

test('telegramPoller: a revoked token stops the loop as invalid', () => withStub(async (s, api) => {
  const states: PollState[] = [], errs: string[] = [];
  s.revoke();
  const pl = poller(api, [], states, errs);
  pl.start();
  await until(() => !pl.running, 'the loop to stop');
  assert.deepEqual(states, ['invalid']);
  assert.ok(!errs[0].includes(s.token.slice(0, 20)));
}));

test('telegramPoller: conflicts in a row mean another PC polls this bot', () => withStub(async (s, api) => {
  const states: PollState[] = [];
  s.failNext('getUpdates', 409, 'Conflict: terminated by other getUpdates request', {}, 3);
  const pl = poller(api, [], states);
  pl.start();
  await until(() => !pl.running, 'the loop to stop');
  assert.deepEqual(states, ['retrying', 'retrying', 'elsewhere']);
}));

test('telegramPoller: stop ends a poll that is waiting on the server', () => withStub(async (s, api) => {
  const pl = new TelegramPoller(api, { onUpdate: () => {}, onState: () => {}, timeoutSec: 30 });
  pl.start();
  await until(() => !!s.state.waiting, 'the stub to hold the poll');
  const t0 = Date.now();
  await pl.stop();
  assert.ok(Date.now() - t0 < 2_000);
}));

test('telegramApi: a 404 that is not from Telegram is not a refused token', async () => {
  const http = await import('node:http');
  const srv = http.createServer((_q, r) => { r.writeHead(404); r.end('nope'); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const api = new TelegramApi('123456789:AAEhBP0av18q1wQ7abcdefghijklmnopqrst', `http://127.0.0.1:${(srv.address() as { port: number }).port}`);
  try { await assert.rejects(api.getMe(), (e: TelegramError) => e.kind === 'bad' && e.code === 404); } finally { srv.close(); }
});

test('telegramPoller: an update the client cannot read is passed by, not asked for again', () => withStub(async (s, api) => {
  const got: TgUpdate[] = [];
  const pl = poller(api, got, []);
  s.push({ message: { message_id: 'x' } });
  s.push(s.user(42, 'fine'));
  pl.start();
  await until(() => got.some((u) => u.message?.text === 'fine'), 'the readable update');
  await pl.stop();
  assert.deepEqual(got.map((u) => u.message?.text), [undefined, 'fine']);
}));

test('telegramPoller: a listener that throws does not stop the loop with an unhandled rejection', () => withStub(async (s, api) => {
  let n = 0;
  const pl = new TelegramPoller(api, { onUpdate: () => { n++; }, onState: () => { throw new Error('listener'); }, timeoutSec: 1 });
  pl.start();
  s.push(s.user(42, 'x'));
  await until(() => n === 1, 'the update');
  await pl.stop();
}));

test('telegramPoller: ids that start over are not taken for ones already seen', () => withStub(async (s, api) => {
  const got: TgUpdate[] = [];
  const pl = poller(api, got, []);
  pl.start();
  s.push({ update_id: 5000, ...s.user(42, 'old') });
  await until(() => got.length === 1, 'the first update');
  s.push({ update_id: 3, ...s.user(42, 'new') });
  await until(() => got.length === 2, 'the update after the ids started over');
  await pl.stop();
}));

test('telegramApi: a file is downloaded by its id through getFile and its address', () => withStub(async (s, api) => {
  s.addFile('doc1', 'hello file', { path: 'documents/file_1.txt' });
  const bytes = await api.download('doc1', 1_000);
  assert.equal(Buffer.from(bytes).toString(), 'hello file');
  assert.deepEqual(s.state.downloads, ['documents/file_1.txt']);
}));

test('telegramApi: a file past the limit is refused, as said or as counted, without the token in the error', () => withStub(async (s, api) => {
  s.addFile('said', 'x', { size: 5_000 });
  s.addFile('counted', 'y'.repeat(2_000));
  for (const id of ['said', 'counted']) {
    await assert.rejects(api.download(id, 1_000), (e: unknown) => e instanceof TelegramError && e.kind === 'bad' && !e.message.includes(s.token));
  }
  assert.deepEqual(s.state.downloads, []);
}));

test('telegramApi: an odd path from getFile never goes into an address', () => withStub(async (s, api) => {
  s.addFile('odd', 'z', { path: '../bot/getMe' });
  await assert.rejects(api.download('odd', 1_000), (e: unknown) => e instanceof TelegramError && e.method === 'getFile');
  assert.deepEqual(s.state.downloads, []);
}));
