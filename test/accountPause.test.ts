import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PAUSE_HOUR_MS, activeOf, allPaused, assignMode, cleanPause, isPaused, nextPauseEnd, pauseEnd, pauseFields, runningOn, sessionAccountStep,
} from '../src/shared/accountPause';

const now = Date.parse('2026-11-27T09:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

test('accountPause: an account saved before the switch existed is on', () => {
  assert.equal(isPaused({}, now), false);
  assert.deepEqual(cleanPause({}, now), { paused: false, pausedUntil: null });
});

test('accountPause: off until switched on stays off', () => {
  const a = { paused: true, pausedUntil: null };
  assert.equal(isPaused(a, now), true);
  assert.equal(assignMode(a, now), 'off');
  assert.equal(pauseEnd(a, now), null);
  assert.deepEqual(cleanPause(a, now), a);
});

test('accountPause: an hour off ends by itself', () => {
  const a = pauseFields('hour', now);
  assert.equal(a.pausedUntil, iso(now + PAUSE_HOUR_MS));
  assert.equal(assignMode(a, now), 'hour');
  assert.equal(pauseEnd(a, now), now + PAUSE_HOUR_MS);
  assert.equal(isPaused(a, now + PAUSE_HOUR_MS), false);
  assert.equal(assignMode(a, now + PAUSE_HOUR_MS + 1), 'on');
});

test('accountPause: loading drops an hour that passed while the app was closed', () => {
  assert.deepEqual(cleanPause({ paused: true, pausedUntil: iso(now - 1) }, now), { paused: false, pausedUntil: null });
  assert.deepEqual(cleanPause({ paused: true, pausedUntil: iso(now + 60_000) }, now), { paused: true, pausedUntil: iso(now + 60_000) });
});

test('accountPause: only true is off; an unreadable end keeps it off', () => {
  assert.equal(isPaused({ paused: 'yes' as unknown as boolean }, now), false);
  assert.equal(isPaused({ paused: true, pausedUntil: 'soon' }, now), true);
  assert.equal(pauseEnd({ paused: true, pausedUntil: 'soon' }, now), null);
});

test('accountPause: switching on clears the pause', () => {
  assert.deepEqual(pauseFields('on', now), { paused: false, pausedUntil: null });
  assert.deepEqual(pauseFields('off', now), { paused: true, pausedUntil: null });
});

test('accountPause: all off needs at least one account', () => {
  const off = { paused: true, pausedUntil: null };
  assert.equal(allPaused([], now), false);
  assert.equal(allPaused([off, off], now), true);
  assert.equal(allPaused([off, {}], now), false);
  const list: { id: string; paused?: boolean; pausedUntil?: string | null }[] = [{ id: 'a', ...off }, { id: 'b' }];
  assert.deepEqual(activeOf(list, now).map((a) => a.id), ['b']);
});

test('accountPause: the next timed pause to end', () => {
  const list = [{ paused: true, pausedUntil: null }, pauseFields('hour', now - 30 * 60_000), pauseFields('hour', now)];
  assert.equal(nextPauseEnd(list, now), now + 30 * 60_000);
  assert.equal(nextPauseEnd([{ paused: true, pausedUntil: null }], now), null);
});

test('accountPause: a turn in progress keeps an account switched off', () => {
  assert.equal(sessionAccountStep({ free: false, live: true, busy: true, paused: true, otherFree: true, begun: true }), 'keep');
});

test('accountPause: an idle session on an account switched off moves to a free one', () => {
  assert.equal(sessionAccountStep({ free: false, live: true, busy: false, paused: true, otherFree: true, begun: false }), 'move');
  assert.equal(sessionAccountStep({ free: false, live: false, busy: false, paused: true, otherFree: true, begun: false }), 'move');
});

test('accountPause: with every account off a new task waits and begun work goes on', () => {
  assert.equal(sessionAccountStep({ free: false, live: true, busy: false, paused: true, otherFree: false, begun: false }), 'wait');
  assert.equal(sessionAccountStep({ free: false, live: false, busy: false, paused: true, otherFree: false, begun: true }), 'wait');
  assert.equal(sessionAccountStep({ free: false, live: true, busy: false, paused: true, otherFree: false, begun: true }), 'keep');
});

test('accountPause: a live session on a limited account keeps it', () => {
  assert.equal(sessionAccountStep({ free: false, live: true, busy: false, paused: false, otherFree: true, begun: false }), 'keep');
  assert.equal(sessionAccountStep({ free: true, live: false, busy: false, paused: false, otherFree: false, begun: false }), 'keep');
});

test('accountPause: what still runs on an account', () => {
  const ws = [
    { accountId: 'a', status: 'running' }, { accountId: 'a', status: 'waiting' }, { accountId: 'a', status: 'idle' }, { accountId: 'b', status: 'running' },
  ];
  assert.equal(runningOn(ws, 'a'), 2);
  assert.equal(runningOn(ws, 'c'), 0);
});
