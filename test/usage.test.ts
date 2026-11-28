import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountWait, chooseAccount, freeAt, isExhausted, limitEnd, liveWindow, nextFreeAt, type RoutableAccount } from '../src/shared/usage';

const now = Date.parse('2026-11-21T09:00:00Z');

test('usage: a window that has reset no longer counts', () => {
  assert.deepEqual(liveWindow({ utilization: 82, resetsAt: '2026-11-20T16:20:00Z' }, now), { utilization: null, resetsAt: null });
});

test('usage: a window still open keeps its value', () => {
  const w = { utilization: 82, resetsAt: '2026-11-21T10:00:00Z' };
  assert.equal(liveWindow(w, now), w);
});

test('usage: no reset time keeps the value', () => {
  const w = { utilization: 40, resetsAt: null };
  assert.equal(liveWindow(w, now), w);
});

const iso = (ms: number) => new Date(ms).toISOString();
const acc = (id: string, five: number | null, seven: number | null, extra: Partial<RoutableAccount> = {}): RoutableAccount => ({
  id,
  fiveHour: { utilization: five, resetsAt: iso(now + 2 * 3600_000) },
  sevenDay: { utilization: seven, resetsAt: iso(now + 3 * 86400_000) },
  limitedUntil: null,
  lastAssignedAt: null,
  ...extra,
});

test('routing: an account above 80% is still used', () => {
  assert.equal(chooseAccount([acc('a', 92, 40)], now)?.id, 'a');
});

test('routing: lowest usage first, however high', () => {
  assert.equal(chooseAccount([acc('a', 97, 40), acc('b', 85, 30)], now)?.id, 'b');
});

test('routing: an account a limit rejected is skipped until it resets', () => {
  const a = acc('a', 10, 10, { limitedUntil: iso(now + 600_000) });
  assert.equal(isExhausted(a, now), true);
  assert.equal(chooseAccount([a, acc('b', 90, 90)], now)?.id, 'b');
  assert.equal(chooseAccount([a], now), null);
  assert.equal(chooseAccount([a], now + 601_000)?.id, 'a');
});

test('routing: the failing account is excluded from its own failover', () => {
  assert.equal(chooseAccount([acc('a', 10, 10), acc('b', 50, 50)], now, 'a')?.id, 'b');
});

test('routing: next free time only when every account is exhausted', () => {
  const a = acc('a', 0, 0, { limitedUntil: iso(now + 900_000) });
  const b = acc('b', 0, 0, { limitedUntil: iso(now + 300_000) });
  assert.equal(nextFreeAt([a, b], now), now + 300_000);
  assert.equal(nextFreeAt([a, acc('c', 99, 99)], now), null);
  assert.equal(nextFreeAt([], now), null);
});

test('routing: a rejection ends at its own reset time', () => {
  assert.equal(limitEnd(acc('a', 100, 50), now, now + 1234_000), now + 1234_000);
});

test('routing: without one, at the latest reset among full windows', () => {
  assert.equal(limitEnd(acc('a', 100, 50), now), now + 2 * 3600_000);
  assert.equal(limitEnd(acc('a', 100, 99), now), now + 3 * 86400_000);
});

test('routing: with nothing to go on, 30 minutes', () => {
  assert.equal(limitEnd(acc('a', 60, null), now), now + 30 * 60_000);
});

const OFF = { paused: true, pausedUntil: null };
const HOUR = (ms: number) => ({ paused: true, pausedUntil: iso(now + ms) });

test('usage: an account switched off gets no new work', () => {
  assert.equal(chooseAccount([acc('a', 10, 10, OFF), acc('b', 70, 70)], now)?.id, 'b');
  assert.equal(chooseAccount([acc('a', 10, 10, OFF)], now), null);
});

test('usage: an hour off ends and the account takes work again', () => {
  const a = acc('a', 10, 10, HOUR(600_000));
  assert.equal(chooseAccount([a], now), null);
  assert.equal(chooseAccount([a], now + 601_000)?.id, 'a');
});

test('usage: when an account is free again counts its pause and its limit', () => {
  assert.equal(freeAt(acc('a', 10, 10), now), 0);
  assert.equal(freeAt(acc('a', 10, 10, OFF), now), Infinity);
  assert.equal(freeAt(acc('a', 10, 10, HOUR(300_000)), now), now + 300_000);
  // Off for an hour and limited for longer: free when both have passed.
  assert.equal(freeAt(acc('a', 10, 10, { ...HOUR(300_000), limitedUntil: iso(now + 900_000) }), now), now + 900_000);
});

test('usage: with every account off indefinitely there is no time to retry at', () => {
  assert.equal(nextFreeAt([acc('a', 10, 10, OFF), acc('b', 10, 10, OFF)], now), null);
  assert.equal(nextFreeAt([acc('a', 10, 10, OFF), acc('b', 10, 10, HOUR(120_000))], now), now + 120_000);
  assert.equal(nextFreeAt([acc('a', 10, 10, OFF), acc('b', 10, 10)], now), null);
});

test('usage: what a task waits for when no account can take it', () => {
  assert.deepEqual(accountWait([acc('a', 10, 10, OFF), acc('b', 10, 10, OFF)], undefined, now), { kind: 'off' });
  assert.deepEqual(accountWait([acc('a', 10, 10, OFF), acc('b', 10, 10, HOUR(120_000))], undefined, now), { kind: 'pause', at: now + 120_000, id: 'b' });
  assert.deepEqual(accountWait([acc('a', 10, 10, OFF), acc('b', 10, 10, { limitedUntil: iso(now + 60_000) })], undefined, now), { kind: 'limit', at: now + 60_000, id: 'b' });
  assert.equal(accountWait([acc('a', 10, 10, OFF), acc('b', 10, 10)], undefined, now), null);
  assert.equal(accountWait([], undefined, now), null);
});

test('usage: an account switched back on ends the wait', () => {
  const list = [acc('a', 10, 10, OFF)];
  assert.deepEqual(accountWait(list, undefined, now), { kind: 'off' });
  list[0] = { ...list[0], paused: false, pausedUntil: null };
  assert.equal(accountWait(list, undefined, now), null);
  assert.equal(chooseAccount(list, now)?.id, 'a');
});
