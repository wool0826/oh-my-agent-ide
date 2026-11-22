import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Burst, cleanTime, inQuietHours } from '../src/shared/notifyRules';

const at = (h: number, m = 0) => new Date(2026, 10, 22, h, m);

test('quiet hours within a day include the start and not the end', () => {
  assert.equal(inQuietHours('12:00', '13:00', at(12, 0)), true);
  assert.equal(inQuietHours('12:00', '13:00', at(12, 59)), true);
  assert.equal(inQuietHours('12:00', '13:00', at(13, 0)), false);
  assert.equal(inQuietHours('12:00', '13:00', at(11, 59)), false);
});

test('quiet hours can pass midnight', () => {
  assert.equal(inQuietHours('22:00', '07:00', at(23, 30)), true);
  assert.equal(inQuietHours('22:00', '07:00', at(3)), true);
  assert.equal(inQuietHours('22:00', '07:00', at(7)), false);
  assert.equal(inQuietHours('22:00', '07:00', at(12)), false);
});

test('without both times, or with the same time twice, nothing is quiet', () => {
  assert.equal(inQuietHours('', '07:00', at(3)), false);
  assert.equal(inQuietHours('22:00', '', at(23)), false);
  assert.equal(inQuietHours('09:00', '09:00', at(9)), false);
  assert.equal(inQuietHours('late', '7', at(3)), false);
  assert.equal(cleanTime('7'), '07:00');
  assert.equal(cleanTime('25:00'), '');
  assert.equal(cleanTime(7), '');
});

test('a burst from one source shows its first notification only, and other sources are not held back', () => {
  const b = new Burst(20_000);
  assert.equal(b.allow('W-01', 0), true);
  assert.equal(b.allow('W-01', 5_000), false);
  assert.equal(b.allow('W-02', 6_000), true);
  // Still inside the window of the one before: the burst goes on.
  assert.equal(b.allow('W-01', 24_000), false);
  assert.equal(b.allow('W-01', 44_000), true);
});
