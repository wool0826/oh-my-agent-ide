import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notifyActions } from '../src/shared/notifyActions';
import { waitStep } from '../src/shared/slots';

test('a permission is answered with Allow or Deny from the notification', () => {
  assert.deepEqual(notifyActions({ source: 'permission', options: [] }).map((a) => a.answer), ['allow', 'deny']);
});

test('a question offers its options when they are few, short and plain', () => {
  const q = (labels: string[], description?: string) => notifyActions({ source: 'question', options: labels.map((label) => ({ label, description })) }).map((a) => a.answer);
  assert.deepEqual(q(['Split', 'Keep as one']), ['Split', 'Keep as one']);
  assert.deepEqual(q(['One']), []);
  assert.deepEqual(q(['a', 'b', 'c', 'd']), []);
  assert.deepEqual(q(['a', 'b'], 'needs reading'), []);
  assert.deepEqual(q(['a', 'x'.repeat(40)]), []);
});

test('a plan has no buttons: it has to be read', () => {
  assert.deepEqual(notifyActions({ source: 'plan', options: [] }), []);
});

test('a waiting task is timed, then gives its slot back, and starts over when it runs again', () => {
  const at = Date.parse('2026-11-22T10:00:00Z');
  const iso = (min: number) => new Date(at + min * 60_000).toISOString();
  assert.equal(waitStep({ status: 'waiting' }, at, 10), 'mark');
  assert.equal(waitStep({ status: 'waiting', waitingSince: iso(0) }, at + 9 * 60_000, 10), null);
  assert.equal(waitStep({ status: 'waiting', waitingSince: iso(0) }, at + 10 * 60_000, 10), 'release');
  assert.equal(waitStep({ status: 'waiting', waitingSince: iso(0), slotReleased: true }, at + 60 * 60_000, 10), null);
  assert.equal(waitStep({ status: 'running', waitingSince: iso(0), slotReleased: true }, at, 10), 'clear');
  assert.equal(waitStep({ status: 'running' }, at, 10), null);
  // 0 minutes: a waiting Worker keeps its slot for as long as it waits.
  assert.equal(waitStep({ status: 'waiting', waitingSince: iso(0) }, at + 600 * 60_000, 0), null);
});
