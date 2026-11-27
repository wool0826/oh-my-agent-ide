import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PAIR_TRIES, Seen, backoffMs, checkPair, fromOwner, isStale, looksLikeToken, makePairCode, maskToken, normPairCode,
  pairCodeIn, pairLink, personName, sameSecret, showPairCode, splitText, type Pairing, type TgUpdate,
} from '../src/shared/remote';

const TOKEN = '123456789:AAEhBP0av18q1wQ7abcdefghijklmnopqrst';
const msg = (from: number, text: string, o: { chat?: number; type?: string; date?: number; bot?: boolean } = {}): TgUpdate => ({
  update_id: 1,
  message: { message_id: 1, date: o.date ?? 1_000_000, chat: { id: o.chat ?? from, type: o.type ?? 'private' }, from: { id: from, first_name: 'Kim', is_bot: o.bot }, text },
});

test('remote: short text is one message', () => {
  assert.deepEqual(splitText('  hello  '), ['hello']);
  assert.deepEqual(splitText(''), []);
});

test('remote: long text splits at a paragraph break first', () => {
  const a = 'a'.repeat(60), b = 'b'.repeat(60);
  assert.deepEqual(splitText(`${a}\n\n${b}`, 100), [a, b]);
  assert.deepEqual(splitText(`${'x '.repeat(40)}${'y'.repeat(40)}`, 100).map((p) => p.length <= 100), [true, true]);
});

test('remote: more pieces than allowed end with the "more" line, inside the limit', () => {
  const parts = splitText(Array.from({ length: 10 }, (_, i) => `${i}`.repeat(90)).join('\n\n'), 100, 3, 'more on desktop');
  assert.equal(parts.length, 3);
  assert.ok(parts[2].endsWith('\nmore on desktop'));
  assert.ok(parts.every((p) => p.length <= 100));
});

test('remote: text with no break is cut at the limit', () => {
  assert.deepEqual(splitText('z'.repeat(250), 100, 5).map((p) => p.length), [100, 100, 50]);
});

test('remote: a bot token is recognised and masked everywhere it shows', () => {
  assert.ok(looksLikeToken(` ${TOKEN} `));
  assert.ok(!looksLikeToken('hello'));
  assert.ok(!looksLikeToken('12:short'));
  assert.equal(maskToken(`fetch https://api.telegram.org/bot${TOKEN}/getMe failed`), 'fetch https://api.telegram.org/bot<token>/getMe failed');
  assert.equal(maskToken(`bad token ${TOKEN}.`), 'bad token <token>.');
  assert.equal(maskToken('/botWHATEVER/sendMessage'), '/bot<token>/sendMessage');
});

test('remote: a pairing code is 8 readable letters from random bytes, shown in two groups', () => {
  const code = makePairCode(Uint8Array.from([0, 1, 2, 3, 28, 29, 30, 31, 99]));
  assert.equal(code, 'ABCD6789');
  assert.match(makePairCode(Uint8Array.from({ length: 8 }, (_, i) => i * 37)), /^[A-HJ-NP-Z2-9]{8}$/);
  assert.equal(showPairCode(code), 'ABCD-6789');
  assert.throws(() => makePairCode(new Uint8Array(4)));
});

test('remote: the code is read from /start, /start@bot or the code alone, in any case', () => {
  assert.equal(pairCodeIn('/start ABCD6789'), 'ABCD6789');
  assert.equal(pairCodeIn('/start@stub_bot abcd-6789'), 'ABCD6789');
  assert.equal(pairCodeIn('abcd-6789'), 'ABCD6789');
  assert.equal(pairCodeIn('ABCD6789'), 'ABCD6789');
  assert.equal(pairCodeIn('/start'), null);
  assert.equal(pairCodeIn('hello there'), null);
  assert.equal(pairCodeIn('/start ABC'), null);
  assert.equal(normPairCode(' k7q2-9fxm '), 'K7Q29FXM');
  assert.equal(pairLink('stub_bot', 'ABCD6789'), 'https://t.me/stub_bot?start=ABCD6789');
});

test('remote: secrets compare equal only when they are equal', () => {
  assert.ok(sameSecret('ABCD6789', 'ABCD6789'));
  assert.ok(!sameSecret('ABCD6789', 'ABCD6788'));
  assert.ok(!sameSecret('ABCD6789', 'ABCD678'));
  assert.ok(!sameSecret('', 'A'));
});

test('remote: the right code in a private chat names the person to confirm and closes the code', () => {
  const p: Pairing = { code: 'ABCD6789', expiresAt: 2_000_000_000, tries: 0 };
  const r = checkPair(p, msg(42, '/start ABCD6789'), 999_000_000, 1_000_000_000);
  assert.equal(r.result, 'match');
  assert.deepEqual(r.who, { id: 42, name: 'Kim' });
  assert.equal(r.pairing, null);
});

test('remote: groups, bots, other chats and old messages do not pair', () => {
  const p: Pairing = { code: 'ABCD6789', expiresAt: 2_000_000_000, tries: 0 };
  const now = 1_000_000_000;
  for (const u of [msg(42, '/start ABCD6789', { type: 'group', chat: -5 }), msg(42, '/start ABCD6789', { bot: true }), msg(42, '/start ABCD6789', { chat: 7 }), msg(42, '/start ABCD6789', { date: 1_000 })]) {
    assert.deepEqual(checkPair(p, u, now - 60_000, now), { pairing: p, result: 'ignore' });
  }
});

test('remote: wrong codes use up the tries; chat and a bare /start do not', () => {
  let p: Pairing | null = { code: 'ABCD6789', expiresAt: 2_000_000_000, tries: 0 };
  const now = 1_000_000_000;
  assert.equal(checkPair(p, msg(42, 'hello'), 0, now).result, 'ignore');
  assert.equal(checkPair(p, msg(42, '/start'), 0, now).result, 'ignore');
  for (let i = 1; i < PAIR_TRIES; i++) {
    const r = checkPair(p, msg(42, '/start WRONG123'), 0, now);
    assert.equal(r.result, 'wrong');
    p = r.pairing;
    assert.equal(p?.tries, i);
  }
  const last = checkPair(p, msg(42, 'WXYZ-2345'), 0, now);
  assert.equal(last.result, 'wrong');
  assert.equal(last.pairing, null);
});

test('remote: an expired code pairs no one', () => {
  const p: Pairing = { code: 'ABCD6789', expiresAt: 1_000, tries: 0 };
  assert.deepEqual(checkPair(p, msg(42, '/start ABCD6789'), 0, 1_000), { pairing: null, result: 'ignore' });
});

test('remote: only the owner in their private chat gets through', () => {
  assert.ok(fromOwner(msg(42, 'hi'), 42));
  assert.ok(!fromOwner(msg(43, 'hi'), 42));
  assert.ok(!fromOwner(msg(42, 'hi', { type: 'group', chat: -1 }), 42));
  assert.ok(!fromOwner(msg(42, 'hi'), null));
  assert.ok(!fromOwner({ update_id: 1 }, 42));
});

test('remote: a person is shown by name, else username, else number', () => {
  assert.equal(personName({ id: 1, first_name: 'Kim', last_name: 'Lee' }), 'Kim Lee');
  assert.equal(personName({ id: 1, username: 'kim' }), '@kim');
  assert.equal(personName({ id: 1 }), '1');
});

test('remote: an update id is handled once, and the list keeps only the latest', () => {
  const s = new Seen(2);
  assert.ok(s.add(1));
  assert.ok(!s.add(1));
  assert.ok(s.add(2));
  assert.ok(s.add(3));
  assert.ok(s.add(1));
});

test('remote: messages older than ten minutes are stale', () => {
  assert.ok(!isStale(1_000, 1_000_000 + 599_000));
  assert.ok(isStale(1_000, 1_000_000 + 601_000));
});

test('remote: the wait after a failure doubles up to a minute', () => {
  assert.deepEqual([1, 2, 3, 7, 20].map((n) => backoffMs(n)), [1_000, 2_000, 4_000, 60_000, 60_000]);
});

test('remote: a cut never splits an emoji in two', () => {
  const parts = splitText(`${'a'.repeat(99)}😀${'b'.repeat(50)}`, 100, 5);
  assert.equal(parts[0], 'a'.repeat(99));
  assert.ok(parts[1].startsWith('😀'));
});

test('remote: five strangers trying codes use up the code', () => {
  let p: Pairing | null = { code: 'ABCD6789', expiresAt: 2_000_000_000, tries: 0 };
  for (let i = 0; i < PAIR_TRIES; i++) p = checkPair(p, msg(100 + i, `/start GUESS${i}XYZ`), 0, 1_000_000_000).pairing;
  assert.equal(p, null);
});
