import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SWIPE_RESIST_MAX, swipeClears, swipeIntent, swipeResist, wheelStart, wheelStep } from '../src/shared/swipe';

test('a press becomes a swipe only when it moves sideways more than down', () => {
  assert.equal(swipeIntent(3, 4), 'wait');
  assert.equal(swipeIntent(12, 2), 'swipe');
  assert.equal(swipeIntent(-12, -3), 'swipe');
  assert.equal(swipeIntent(2, 12), 'scroll');
  // A diagonal drag is a scroll: the list scrolls rather than a row moving away.
  assert.equal(swipeIntent(10, 10), 'scroll');
});

test('letting go clears past 35% of the width or after a quick flick toward the same side', () => {
  assert.equal(swipeClears(104, 0, 300), false);
  assert.equal(swipeClears(105, 0, 300), true);
  assert.equal(swipeClears(-110, 0, 300), true);
  assert.equal(swipeClears(40, 1, 300), true);
  assert.equal(swipeClears(-40, -1, 300), true);
  // A flick back toward where it started, or too short a move, does not.
  assert.equal(swipeClears(60, -1, 300), false);
  assert.equal(swipeClears(20, 2, 300), false);
  assert.equal(swipeClears(0, 2, 300), false);
});

test('a row that cannot be cleared follows a little and stops', () => {
  assert.equal(swipeResist(0), 0);
  assert.ok(swipeResist(30) > 0 && swipeResist(30) < 10);
  assert.ok(swipeResist(1000) <= SWIPE_RESIST_MAX && swipeResist(1000) > SWIPE_RESIST_MAX - 1);
  assert.equal(swipeResist(-200), -swipeResist(200));
});

test('a touchpad swipe follows the fingers against the scroll and stays a scroll once it is one', () => {
  let s = wheelStart();
  s = wheelStep(s, 3, 0);
  assert.equal(s.mode, 'wait');
  s = wheelStep(s, 9, 1);
  assert.deepEqual([s.mode, s.dx], ['swipe', -12]);
  // Later vertical bits do not stop a swipe, and the row never goes past its width.
  s = wheelStep(s, 500, 40, 0, 300);
  assert.deepEqual([s.mode, s.dx], ['swipe', -300]);
  assert.equal(wheelStep(wheelStart(), -1, 0, 1).dx, 16);
  let v = wheelStep(wheelStart(), 2, 20);
  assert.equal(v.mode, 'scroll');
  v = wheelStep(v, 200, 0);
  assert.equal(v.mode, 'scroll');
});
