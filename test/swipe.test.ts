import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SWIPE_RESIST_MAX, WHEEL_IDLE, swipeClearAt, swipeClears, swipeIntent, swipeResist, wheelRelease, wheelShown, wheelStart, wheelStep } from '../src/shared/swipe';

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

// Wheel events every 16ms from `t0`: one per delta, sideways unless `dy` is given.
type Ev = number | [number, number];
function play(deltas: Ev[], width = 300, s = wheelStart(), t0 = 0) {
  deltas.forEach((d, i) => { const [x, y] = typeof d === 'number' ? [d, 0] : d; s = wheelStep(s, { deltaX: x, deltaY: y, t: t0 + i * 16 }, width); });
  return s;
}
// What a macOS touchpad sends after the fingers leave moving at `step` px a frame: fading steps, rounded, to 0.
const momentum = (step: number, n = 40) => Array.from({ length: n }, (_, i) => Math.round(step * 0.95 ** (i + 1))).filter(Boolean);

test('swipe: a touchpad swipe follows the fingers against the scroll and stays a scroll once it is one', () => {
  let s = play([3, 6]);
  assert.equal(s.mode, 'wait');
  s = play([4], 300, s, 32);
  assert.deepEqual([s.mode, s.dx], ['swipe', -13]);
  // Later vertical bits do not stop a swipe, and the row never goes past its width.
  s = play([[500, 40]], 300, s, 48);
  assert.deepEqual([s.mode, s.dx], ['swipe', -300]);
  assert.equal(wheelStep(wheelStart(), { deltaX: -1, deltaY: 0, deltaMode: 1, t: 0 }).dx, 16);
  let v = play([[2, 20]]);
  assert.equal(v.mode, 'scroll');
  v = play([200], 300, v, 16);
  assert.equal(v.mode, 'scroll');
});

test('swipe: a gesture that starts down a little is still a swipe once it goes sideways', () => {
  const s = play([[0, 1], [0, 1], [6, 0], [8, 0]]);
  assert.equal(s.mode, 'swipe');
});

test('swipe: the momentum after the fingers leave moves nothing and lets the row go where they left it', () => {
  const fingers = [-6, -10, -14, -18, -20, -22];
  const s = play([...fingers, ...momentum(22)]);
  assert.ok(s.done, 'let go before the momentum ends');
  assert.equal(s.done.dx, 90);
  assert.equal(wheelShown(s), 90);
  // Moving fast when they left: a flick, so it clears though short of the distance.
  assert.ok(s.done.v > 1);
  assert.equal(swipeClears(s.done.dx, s.done.v, 300), true);
});

test('swipe: a slow short swipe with a short momentum tail comes back', () => {
  const s = play([-3, -4, -5, -5, -4, -3, -2, -1]);
  const at = wheelRelease(s, s.t + WHEEL_IDLE);
  assert.ok(at.dx < 30);
  assert.equal(swipeClears(at.dx, at.v, 300), false);
});

test('swipe: the momentum alone never takes the row past the distance that clears it', () => {
  // Under the distance when the fingers left; the momentum would add more than 100px.
  const s = play([-10, -15, -20, -25, ...momentum(25, 60)]);
  assert.ok(s.done);
  assert.equal(s.done.dx, 70);
  assert.ok(momentum(25, 60).reduce((a, b) => a + b, 0) > 100);
});

test('swipe: an empty event as the fingers leave lets the row go at once', () => {
  const s = wheelStep(play([-20, -30, -40, -40]), { deltaX: 0, deltaY: 0, t: 70 }, 300);
  assert.deepEqual(s.done && [s.done.dx, s.done.v > 0], [130, true]);
  assert.equal(swipeClears(s.done!.dx, s.done!.v, 300), true);
  // Nothing after that moves it.
  assert.equal(wheelStep(s, { deltaX: -50, deltaY: 0, t: 90 }, 300).dx, 130);
});

test('swipe: equal steps (a tilt wheel held, a mouse) are fingers, not momentum', () => {
  const s = play([-20, -20, -20, -20, -20, -20, -20]);
  assert.equal(s.done, null);
  assert.equal(wheelShown(s), 140);
  // Once the steps stop for a while, it is let go where it is, not flicked.
  const at = wheelRelease(s, s.t + WHEEL_IDLE);
  assert.deepEqual(at, { dx: 140, v: 0 });
  assert.equal(swipeClears(at.dx, at.v, 300), true);
});

test('swipe: fingers that slow down and speed up again keep moving the row', () => {
  const s = play([-10, -12, -11, -10, -14, -16]);
  assert.equal(s.done, null);
  assert.equal(wheelShown(s), 73);
});

test('swipe: fingers moving at an uneven speed are not taken for momentum', () => {
  const s = play([-12, -14, -13, -15, -14, -12, -16, -13, -15, -11, -14]);
  assert.equal(s.done, null);
  assert.equal(wheelShown(s), s.dx);
});

test('swipe: fingers resting before they leave do not flick the row', () => {
  const s = play([-10, -15, -20]);
  assert.deepEqual(wheelRelease(s, s.t + WHEEL_IDLE), { dx: 45, v: 0 });
  assert.equal(swipeClears(45, 0, 300), false);
});

test('swipe: the distance that clears a row is a share of its width kept between 80 and 120px', () => {
  assert.equal(swipeClearAt(300), 105);
  assert.equal(swipeClearAt(600), 120);
  assert.equal(swipeClearAt(150), 80);
  assert.equal(swipeClearAt(60), 60);
});
