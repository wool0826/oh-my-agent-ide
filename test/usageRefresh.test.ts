import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampUsageMins, limitWindow, usageFoot, usedUp, type FootAccount, type UsageClock } from '../src/shared/usage';
import { readUnifiedHeaders } from '../src/shared/usageHeaders';

const now = Date.parse('2026-11-23T14:00:00Z');
const headers = (h: Record<string, string>) => (n: string) => h[n] ?? null;
const P = 'anthropic-ratelimit-unified-';

test('usage headers: both windows as percent, resets as ISO times', () => {
  const u = readUnifiedHeaders(headers({
    [`${P}status`]: 'allowed',
    [`${P}5h-utilization`]: '0.86',
    [`${P}5h-reset`]: '1795442400',
    [`${P}7d-utilization`]: '0.413',
    [`${P}7d-reset`]: '1795874400',
  }));
  assert.deepEqual(u, {
    fiveHour: { utilization: 86, resetsAt: new Date(1795442400 * 1000).toISOString() },
    sevenDay: { utilization: 41, resetsAt: new Date(1795874400 * 1000).toISOString() },
    rejected: false,
    rejectedUntil: null,
  });
});

test('usage headers: none at all is null, a missing window is null', () => {
  assert.equal(readUnifiedHeaders(headers({ 'content-type': 'application/json' })), null);
  const u = readUnifiedHeaders(headers({ [`${P}7d-utilization`]: '0.2' }));
  assert.equal(u?.fiveHour, null);
  assert.deepEqual(u?.sevenDay, { utilization: 20, resetsAt: null });
});

test('usage headers: a bad number is no figure', () => {
  const u = readUnifiedHeaders(headers({ [`${P}status`]: 'allowed', [`${P}5h-utilization`]: 'n/a', [`${P}7d-utilization`]: '' }));
  assert.equal(u?.fiveHour, null);
  assert.equal(u?.sevenDay, null);
});

test('usage headers: a refusal ends at its own reset, else at the window that refused', () => {
  const own = readUnifiedHeaders(headers({ [`${P}status`]: 'rejected', [`${P}reset`]: '1795442400', [`${P}7d-utilization`]: '1' }));
  assert.equal(own?.rejected, true);
  assert.equal(own?.rejectedUntil, 1795442400 * 1000);
  const win = readUnifiedHeaders(headers({ [`${P}7d-status`]: 'rejected', [`${P}7d-reset`]: '1795874400', [`${P}5h-reset`]: '1795442400' }));
  assert.equal(win?.rejected, true);
  assert.equal(win?.rejectedUntil, 1795874400 * 1000);
});

test('usage interval: only the offered values, 5 minutes otherwise', () => {
  assert.equal(clampUsageMins(15), 15);
  assert.equal(clampUsageMins(0), 0);
  assert.equal(clampUsageMins('30'), 30);
  assert.equal(clampUsageMins(1), 5);
  assert.equal(clampUsageMins(undefined), 5);
});

test('usage limit: the window whose reset is the end of the limit', () => {
  const end = '2026-11-25T14:30:00Z';
  assert.equal(limitWindow({ fiveHour: { utilization: 42, resetsAt: '2026-11-23T16:00:00Z' }, sevenDay: { utilization: 100, resetsAt: end }, limitedUntil: end }), '7d');
  assert.equal(limitWindow({ fiveHour: { utilization: 100, resetsAt: '2026-11-23T16:00:00Z' }, sevenDay: { utilization: 60, resetsAt: end }, limitedUntil: '2026-11-23T16:00:20Z' }), '5h');
  assert.equal(limitWindow({ fiveHour: { utilization: null, resetsAt: null }, sevenDay: { utilization: 100, resetsAt: null }, limitedUntil: end }), '7d');
  assert.equal(limitWindow({ fiveHour: { utilization: null, resetsAt: null }, sevenDay: { utilization: null, resetsAt: null }, limitedUntil: end }), null);
  assert.equal(limitWindow({ fiveHour: { utilization: 100, resetsAt: end }, sevenDay: { utilization: 10, resetsAt: null }, limitedUntil: null }), null);
});

test('usage toolbar: a used-up account comes back when its limit ends, else at the latest full window reset', () => {
  const w = (utilization: number | null, resetsAt: string | null = null) => ({ utilization, resetsAt });
  // Not used up: nothing beside the rings, however high.
  assert.equal(usedUp({ limited: false, limitedUntil: null, fiveHour: w(99, '2026-11-23T16:00:00Z'), sevenDay: w(21) }, now), null);
  // A limit with its end.
  assert.deepEqual(usedUp({ limited: true, limitedUntil: '2026-11-25T14:30:00Z', fiveHour: w(42), sevenDay: w(100, '2026-11-25T14:30:00Z') }, now), { at: '2026-11-25T14:30:00Z' });
  // A full window without a limit seen yet, or both full: the later reset.
  assert.deepEqual(usedUp({ limited: false, limitedUntil: null, fiveHour: w(100, '2026-11-23T16:00:00Z'), sevenDay: w(60) }, now), { at: '2026-11-23T16:00:00Z' });
  assert.deepEqual(usedUp({ limited: false, limitedUntil: null, fiveHour: w(100, '2026-11-23T16:00:00Z'), sevenDay: w(100, '2026-11-25T14:30:00Z') }, now), { at: '2026-11-25T14:30:00Z' });
  // Limited with no time known, by no full window.
  assert.deepEqual(usedUp({ limited: true, limitedUntil: null, fiveHour: w(null), sevenDay: w(null) }, now), { at: null });
  assert.deepEqual(usedUp({ limited: true, limitedUntil: null, fiveHour: w(80, '2026-11-23T16:00:00Z'), sevenDay: w(90) }, now), { at: null });
  // A reset that has passed since the figures were read: the usage is back.
  const later = Date.parse('2026-11-23T17:00:00Z');
  assert.equal(usedUp({ limited: false, limitedUntil: null, fiveHour: w(100, '2026-11-23T16:00:00Z'), sevenDay: w(60) }, later), null);
  assert.equal(usedUp({ limited: true, limitedUntil: '2026-11-23T16:00:00Z', fiveHour: w(100, '2026-11-23T16:00:00Z'), sevenDay: w(60) }, later), null);
});

const acc = (x: Partial<FootAccount> = {}): FootAccount => ({ kind: 'token', provider: 'claude', lastError: null, usageUpdatedAt: '2026-11-23T13:58:00Z', usageBackoffUntil: null, ...x });
const clock = (x: Partial<UsageClock> = {}): UsageClock => ({ checkedAt: '2026-11-23T13:58:00Z', nextAt: '2026-11-23T14:03:00Z', running: false, ...x });

test('usage foot: last and next round, and how many failed', () => {
  assert.deepEqual(usageFoot(clock(), [acc(), acc()], now), { kind: 'ok', at: '2026-11-23T13:58:00Z', next: '2026-11-23T14:03:00Z', failed: 0, total: 2 });
  assert.deepEqual(usageFoot(clock(), [acc(), acc({ lastError: 'Usage lookup failed (500)' })], now), { kind: 'ok', at: '2026-11-23T13:58:00Z', next: '2026-11-23T14:03:00Z', failed: 1, total: 2 });
  assert.deepEqual(usageFoot(clock({ nextAt: null }), [acc()], now), { kind: 'ok', at: '2026-11-23T13:58:00Z', next: null, failed: 0, total: 1 });
});

test('usage foot: a running round names the last one', () => {
  assert.deepEqual(usageFoot(clock({ running: true }), [acc()], now), { kind: 'running', was: '2026-11-23T13:58:00Z' });
});

test('usage foot: paused while the server asked every account to wait', () => {
  const f = usageFoot(clock(), [acc({ usageBackoffUntil: '2026-11-23T14:31:00Z' }), acc({ usageBackoffUntil: '2026-11-23T14:20:00Z' })], now);
  assert.deepEqual(f, { kind: 'paused', until: '2026-11-23T14:20:00.000Z' });
  // A wait that is over does not count.
  assert.equal(usageFoot(clock(), [acc({ usageBackoffUntil: '2026-11-23T13:00:00Z' })], now).kind, 'ok');
});

test('usage foot: every account failed gives the time of the last figures', () => {
  const f = usageFoot(clock(), [acc({ lastError: 'x', usageUpdatedAt: '2026-11-23T13:04:00Z' }), acc({ lastError: 'y', usageUpdatedAt: null })], now);
  assert.deepEqual(f, { kind: 'failed', last: '2026-11-23T13:04:00Z' });
});

test('usage foot: login accounts are read from their sessions, not by a round', () => {
  assert.deepEqual(usageFoot(clock(), [acc({ kind: 'login' })], now), { kind: 'sessions' });
  // A ChatGPT account is read by the round.
  assert.equal(usageFoot(clock(), [acc({ kind: 'login', provider: 'chatgpt' })], now).kind, 'ok');
});
