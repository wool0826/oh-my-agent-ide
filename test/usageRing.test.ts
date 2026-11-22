import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RING, ringArc } from '../src/shared/usageRing';

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
