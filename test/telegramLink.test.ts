import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramLink, type LinkCrypt, type LinkStore } from '../src/main/remote/telegramLink';
import { cleanTelegram, type TelegramStored } from '../src/shared/remote';
import { startTelegramStub, type TelegramStub } from './e2e/telegram-stub.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-telegram-'));
process.env.OMA_DATA_DIR = tmp;
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ home: path.join(tmp, 'home'), language: 'en', accounts: [] }));

async function until(ok: () => boolean, what: string, ms = 5_000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise<void>((r) => setImmediate(r));
  }
}

/** settings.json in memory. */
function memStore(cfg: Partial<TelegramStored> = {}) {
  const box = { tokenEnc: '', cfg: { ...cleanTelegram(null), ...cfg } };
  const store: LinkStore = {
    load: () => ({ tokenEnc: box.tokenEnc, cfg: { ...box.cfg } }),
    save: (tokenEnc, c) => { box.tokenEnc = tokenEnc; box.cfg = { ...c }; },
  };
  return { box, store };
}

/** Stands in for safeStorage: reversible, and never the plain token. */
const crypt = (available = true): LinkCrypt => ({
  available: () => available,
  encrypt: (s) => `enc:${Buffer.from([...s].reverse().join('')).toString('base64')}`,
  decrypt: (s) => [...Buffer.from(s.slice(4), 'base64').toString()].reverse().join(''),
});

type Box = ReturnType<typeof memStore>['box'];

async function withLink(fn: (s: TelegramStub, link: TelegramLink, box: Box) => Promise<void>, cfg: Partial<TelegramStored> = { enabled: true }) {
  const s = await startTelegramStub();
  const { box, store } = memStore(cfg);
  const link = new TelegramLink(store, crypt(), s.url, 1);
  try { await fn(s, link, box); } finally { await link.halt(); await s.close(); }
}

const polling = (s: TelegramStub) => !!s.state.waiting;
const PAIRED: Partial<TelegramStored> = { enabled: true, botId: 123456789, botName: 'stub_bot', ownerId: 42, ownerName: 'Owner' };

test('telegramLink: a token that is not one, or no safeStorage, stores nothing and calls nobody', async () => {
  const s = await startTelegramStub();
  try {
    const a = memStore({ enabled: true });
    await assert.rejects(new TelegramLink(a.store, crypt(), s.url).setToken('hello'), /Not a bot token/);
    const b = memStore({ enabled: true });
    await assert.rejects(new TelegramLink(b.store, crypt(false), s.url).setToken(s.token), /cannot encrypt/);
    assert.equal(a.box.tokenEnc + b.box.tokenEnc, '');
    assert.equal(s.state.calls.length, 0);
  } finally { await s.close(); }
});

test('telegramLink: a token Telegram refuses is not stored', () => withLink(async (_s, link, box) => {
  await assert.rejects(link.setToken('987654321:AAEhBP0av18q1wQ7wrongwrongwrongwrong'), /Telegram refused this token/);
  assert.equal(box.tokenEnc, '');
}));

test('telegramLink: a good token is stored encrypted, the bot named, and a code opened', () => withLink(async (s, link, box) => {
  await link.setToken(` ${s.token} `);
  assert.ok(box.tokenEnc.startsWith('enc:'));
  assert.ok(!JSON.stringify(box).includes(s.token), 'never stored in plain');
  const v = link.view();
  assert.equal(v.bot, 'stub_bot');
  assert.equal(v.status, 'pairing');
  assert.match(v.code ?? '', /^[A-Z2-9]{8}$/);
  assert.equal(v.link, `https://t.me/stub_bot?start=${v.code}`);
  assert.ok(!JSON.stringify(v).includes(s.token), 'the page never sees the token');
  await until(() => polling(s), 'polling for the code');
}));

test('telegramLink: only the right code from a private chat names a sender; confirming says hello to them only', () => withLink(async (s, link, box) => {
  await link.setToken(s.token);
  await until(() => polling(s), 'polling');
  const code = link.view().code!;
  s.push(s.user(777, 'hello?', { name: 'Stranger' }));
  s.push(s.user(555, `/start ${code}`, { type: 'group' }));
  s.push(s.user(42, `/start ${code}`, { name: 'Owner' }));
  await until(() => !!link.view().candidate, 'the candidate');
  assert.deepEqual(link.view().candidate, { id: 42, name: 'Owner' });
  assert.equal(link.view().code, null);
  await until(() => !polling(s), 'polling to stop while the desktop decides');
  await link.confirm();
  assert.equal(box.cfg.ownerId, 42);
  assert.equal(link.view().status, 'connected');
  assert.deepEqual(s.state.sent.map((m) => m.chat_id), [42]);
  assert.match(s.state.sent[0].text, /connected/);
  assert.ok(link.ready);
}));

test('telegramLink: five wrong codes close the code; a new one can be opened', () => withLink(async (s, link) => {
  await link.setToken(s.token);
  await until(() => polling(s), 'polling');
  for (let i = 0; i < 5; i++) s.push(s.user(900 + i, `/start WRONG${i}XY`));
  await until(() => link.view().code === null, 'the code to close');
  await until(() => !polling(s), 'polling to stop');
  assert.equal(link.view().status, 'pairing');
  assert.equal(link.view().candidate, null);
  link.newCode();
  assert.ok(link.view().code);
}));

test('telegramLink: rejecting the sender opens a different code', () => withLink(async (s, link) => {
  await link.setToken(s.token);
  const first = link.view().code!;
  s.push(s.user(42, first));
  await until(() => !!link.view().candidate, 'the candidate');
  link.reject();
  assert.equal(link.view().candidate, null);
  assert.ok(link.view().code && link.view().code !== first);
}));

test('telegramLink: a new token for the same bot keeps the owner; another bot drops it', () => withLink(async (s, link, box) => {
  await link.setToken(s.token);
  assert.equal(link.view().owner?.id, 42);
  assert.equal(link.view().code, null, 'paired: no code, no polling');
  s.state.token = '123456789:AAEhBP0av18q1wQ7newnewnewnewnewnewne';
  await link.setToken(s.state.token);
  assert.equal(box.cfg.ownerId, 42);
  s.state.token = '555555555:AAEhBP0av18q1wQ7otherotherotherother';
  s.state.bot = { ...s.state.bot, id: 555555555, username: 'other_bot' };
  await link.setToken(s.state.token);
  assert.equal(box.cfg.ownerId, null);
  assert.equal(link.view().bot, 'other_bot');
  assert.equal(link.view().status, 'pairing');
}, PAIRED));

test('telegramLink: a revoked token marks the link invalid once, and a new token clears it', () => withLink(async (s, link) => {
  await link.setToken(s.token);
  let told = 0;
  link.on('invalid', () => { told++; });
  s.revoke();
  await assert.rejects(link.send('x'), (e: Error) => !e.message.includes(s.token));
  await assert.rejects(link.test(), /refused/);
  assert.equal(told, 1);
  assert.equal(link.view().status, 'invalid');
  assert.ok(!link.ready);
  await link.setToken(s.state.token);
  assert.equal(link.view().status, 'connected');
}, PAIRED));

test('telegramLink: at launch a revoked token shows as invalid', async () => {
  const s = await startTelegramStub();
  try {
    const { box, store } = memStore(PAIRED);
    box.tokenEnc = crypt().encrypt(s.token);
    s.revoke();
    const link = new TelegramLink(store, crypt(), s.url);
    await link.init();
    assert.equal(link.view().status, 'invalid');
  } finally { await s.close(); }
});

test('telegramLink: turning it off stops polling; disconnect forgets token, bot and owner', () => withLink(async (s, link, box) => {
  await link.setToken(s.token);
  await until(() => polling(s), 'polling');
  await link.setEnabled(false);
  assert.equal(link.view().status, 'off');
  await until(() => !polling(s), 'polling to stop');
  await link.setEnabled(true);
  assert.ok(link.view().code, 'a code again');
  await link.disconnect();
  assert.equal(box.tokenEnc, '');
  assert.deepEqual(box.cfg, { ...cleanTelegram(null), enabled: true });
  assert.equal(link.view().status, 'token');
  await assert.rejects(link.send('x'), /not connected/);
}));
