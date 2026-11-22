import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RING, ringArc, untilReset } from '../src/shared/usageRing';

test('the arc is the share of the circumference', () => {
  assert.equal(ringArc(50, 10), '31.42 62.83');
  assert.equal(ringArc(100, 10), '62.83 62.83');
  assert.equal(ringArc(25, RING.fiveHour), '8.64 34.56');
});

test('nothing is drawn for unknown or zero usage, and more than 100% is a full ring', () => {
  assert.equal(ringArc(null, 10), null);
  assert.equal(ringArc(0, 10), null);
  assert.equal(ringArc(140, 10), '62.83 62.83');
});

test('the 7-day ring is the outer one', () => {
  assert.ok(RING.sevenDay > RING.fiveHour);
});

test('the time to a reset is its two largest units', () => {
  const now = Date.parse('2026-11-22T00:00:00Z');
  const at = (mins: number) => new Date(now + mins * 60_000).toISOString();
  assert.deepEqual(untilReset(at(134), now), [{ unit: 'h', n: 2 }, { unit: 'm', n: 14 }]);
  assert.deepEqual(untilReset(at(3 * 1440 + 4 * 60 + 20), now), [{ unit: 'd', n: 3 }, { unit: 'h', n: 4 }]);
  assert.deepEqual(untilReset(at(9), now), [{ unit: 'm', n: 9 }]);
  assert.deepEqual(untilReset(at(120), now), [{ unit: 'h', n: 2 }]);
  assert.deepEqual(untilReset(at(2 * 1440 + 5), now), [{ unit: 'd', n: 2 }]);
});

test('a reset that is unknown or past has no time left', () => {
  const now = Date.parse('2026-11-22T00:00:00Z');
  assert.equal(untilReset(null, now), null);
  assert.equal(untilReset('2026-11-21T23:00:00Z', now), null);
});
