import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveWindow } from '../src/shared/usage';

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
