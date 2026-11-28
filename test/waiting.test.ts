import { test } from 'node:test';
import assert from 'node:assert/strict';
import { badgeText, stepWaiting } from '../src/shared/waiting';

const ids = ['d1', 'd2', 'd3'];

test('waiting: nothing waits, nowhere to go', () => {
  assert.equal(stepWaiting([], 'd1', null, 1), null);
  assert.equal(stepWaiting([], null, null, -1), null);
});

test('waiting: the first press goes to the card selected in the inbox', () => {
  assert.equal(stepWaiting(ids, 'd1', null, 1), 'd1');
  assert.equal(stepWaiting(ids, 'd2', null, 1), 'd2');
  assert.equal(stepWaiting(ids, 'd2', 'd1', -1), 'd2');
});

test('waiting: each later press steps on and goes round the ends', () => {
  assert.equal(stepWaiting(ids, 'd1', 'd1', 1), 'd2');
  assert.equal(stepWaiting(ids, 'd3', 'd3', 1), 'd1');
  assert.equal(stepWaiting(ids, 'd1', 'd1', -1), 'd3');
  assert.equal(stepWaiting(ids, 'd2', 'd2', -1), 'd1');
});

test('waiting: with no card selected, Next starts at the first and Previous at the last', () => {
  assert.equal(stepWaiting(ids, null, null, 1), 'd1');
  assert.equal(stepWaiting(ids, null, null, -1), 'd3');
  assert.equal(stepWaiting(ids, 'gone', 'gone', 1), 'd1');
});

test('waiting: after an answer, the card selected in its place is the next stop', () => {
  // d1 was answered: the inbox selected d2, which the previous press did not go to.
  assert.equal(stepWaiting(['d2', 'd3'], 'd2', 'd1', 1), 'd2');
});

test('waiting: one waiting item stays the stop', () => {
  assert.equal(stepWaiting(['d1'], 'd1', 'd1', 1), 'd1');
  assert.equal(stepWaiting(['d1'], 'd1', 'd1', -1), 'd1');
});

test('waiting: a badge shows nothing at 0, the number to 9, then 9+', () => {
  assert.equal(badgeText(0), '');
  assert.equal(badgeText(-1), '');
  assert.equal(badgeText(1), '1');
  assert.equal(badgeText(9), '9');
  assert.equal(badgeText(10), '9+');
  assert.equal(badgeText(12), '9+');
});
