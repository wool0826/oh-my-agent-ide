import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountWarning, clampWarnAt, exhaustAt, nearLimit, newWarnings, leaveEarly, stripWarning, winName, type WarnAccount } from '../src/shared/usageForecast';

const NOW = Date.parse('2026-11-28T12:50:00Z');
const at = (min: number) => new Date(NOW + min * 60_000).toISOString();
const none = { utilization: null, resetsAt: null };
const acc = (id: string, five: number | null, fiveReset: number, extra: Partial<WarnAccount> = {}): WarnAccount => ({
  id, limited: false, limitedUntil: null, paused: false, pausedUntil: null,
  fiveHour: { utilization: five, resetsAt: at(fiveReset) }, sevenDay: none, ...extra,
});

test('usageForecast: the pace since the window began says when it runs out', () => {
  // The 5h window began 210 min ago (reset in 90): 91% in 210 min leaves 9% for about 21 min more.
  const t = exhaustAt({ utilization: 91, resetsAt: at(90) }, 300, NOW);
  assert.ok(t !== null);
  assert.equal(Math.round((t - NOW) / 60_000), 21);
});

test('usageForecast: no forecast when it lasts until the reset, or nothing is known', () => {
  assert.equal(exhaustAt({ utilization: 30, resetsAt: at(90) }, 300, NOW), null);
  assert.equal(exhaustAt({ utilization: null, resetsAt: at(90) }, 300, NOW), null);
  assert.equal(exhaustAt({ utilization: 50, resetsAt: null }, 300, NOW), null);
  assert.equal(exhaustAt({ utilization: 95, resetsAt: at(-1) }, 300, NOW), null);
});

test('usageForecast: a full window runs out now', () => {
  assert.equal(exhaustAt({ utilization: 100, resetsAt: at(30) }, 300, NOW), NOW);
});

test('usageForecast: under the threshold or switched off, no warning', () => {
  assert.equal(accountWarning(acc('a', 89, 90), 90, NOW), null);
  assert.equal(accountWarning(acc('a', 95, 90, { paused: true }), 90, NOW), null);
  assert.equal(accountWarning(acc('a', 95, -5), 90, NOW), null);
});

test('usageForecast: past the threshold, the fuller window with its forecast', () => {
  const w = accountWarning(acc('a', 91, 90, { sevenDay: { utilization: 93, resetsAt: at(3000) } }), 90, NOW);
  assert.equal(w?.kind, 'warn');
  assert.equal(w?.kind === 'warn' && w.win, 1);
  assert.equal(w?.kind === 'warn' && w.pct, 93);
});

test('usageForecast: a used-up account is a limit with its time back', () => {
  const w = accountWarning(acc('a', 40, 90, { limited: true, limitedUntil: at(60) }), 90, NOW);
  assert.deepEqual(w, { kind: 'limit', id: 'a', at: at(60) });
});

test('usageForecast: the strip shows a limit first, else the fullest account', () => {
  const list = [acc('a', 92, 90), acc('b', 97, 90), acc('c', 10, 90)];
  assert.equal(stripWarning(list, 90, NOW)?.id, 'b');
  const limited = [...list, acc('d', 0, 90, { limited: true, limitedUntil: at(200) }), acc('e', 0, 90, { limited: true, limitedUntil: at(100) })];
  assert.deepEqual(stripWarning(limited, 90, NOW), { kind: 'limit', id: 'e', at: at(100) });
  assert.equal(stripWarning([acc('c', 10, 90)], 90, NOW), null);
});

test('usageForecast: a crossing is told once per window period', () => {
  const seen = new Set<string>();
  assert.equal(newWarnings([acc('a', 91, 90)], 90, seen, NOW).length, 1);
  assert.equal(newWarnings([acc('a', 94, 90)], 90, seen, NOW).length, 0);
  // The next 5h window is a new period.
  assert.equal(newWarnings([acc('a', 91, 390)], 90, seen, NOW).length, 1);
});

test('usageForecast: near the limit means past the threshold in a live window', () => {
  assert.equal(nearLimit(acc('a', 91, 90), 90, NOW), true);
  assert.equal(nearLimit(acc('a', 89, 90), 90, NOW), false);
  assert.equal(nearLimit(acc('a', 99, -1), 90, NOW), false);
});

test('usageForecast: a threshold is one of 80, 90, 95', () => {
  assert.equal(clampWarnAt(80), 80);
  assert.equal(clampWarnAt('95'), 95);
  assert.equal(clampWarnAt(42), 90);
  assert.equal(clampWarnAt(undefined), 90);
});

test('usageForecast: a window is named 5h and 7d, or by a ChatGPT plan\'s own length', () => {
  assert.equal(winName(0), '5h');
  assert.equal(winName(1, null), '7d');
  assert.equal(winName(0, [300, 10080]), '5h');
  assert.equal(winName(1, [null, 43200]), '30d');
});

test('usageForecast: a session leaves an account past the threshold only for one under it', () => {
  const list = [acc('a', 92, 90), acc('b', 40, 90), acc('c', 95, 90)];
  assert.equal(leaveEarly(list, 'a', 90, 'claude', NOW), true);
  assert.equal(leaveEarly(list, 'b', 90, 'claude', NOW), false);
  // Every other account is past it too, limited or switched off: it stays.
  assert.equal(leaveEarly([acc('a', 92, 90), acc('c', 95, 90)], 'a', 90, 'claude', NOW), false);
  assert.equal(leaveEarly([acc('a', 92, 90), acc('b', 40, 90, { paused: true })], 'a', 90, 'claude', NOW), false);
  assert.equal(leaveEarly([acc('a', 92, 90), acc('b', 40, 90, { limitedUntil: at(30) })], 'a', 90, 'claude', NOW), false);
  assert.equal(leaveEarly([acc('a', 92, 90), { ...acc('b', 40, 90), provider: 'chatgpt' }], 'a', 90, 'claude', NOW), false);
});
