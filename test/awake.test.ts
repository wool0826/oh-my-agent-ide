import { test } from 'node:test';
import assert from 'node:assert/strict';
import { awakeHolder, shouldStayAwake } from '../src/shared/awake';

const ws = (...statuses: string[]) => statuses.map((status) => ({ status }));

test('awake: a running, starting or waiting Worker keeps the computer awake', () => {
  for (const st of ['running', 'starting', 'waiting']) assert.equal(shouldStayAwake({ on: true, workers: ws('idle', st), dispatcherBusy: false }), true, st);
});

test('awake: idle, failed and archived Workers let the computer sleep', () => {
  assert.equal(shouldStayAwake({ on: true, workers: ws('idle', 'error', 'archived'), dispatcherBusy: false }), false);
  assert.equal(shouldStayAwake({ on: true, workers: [], dispatcherBusy: false }), false);
});

test('awake: the Dispatcher in a turn keeps the computer awake', () => {
  assert.equal(shouldStayAwake({ on: true, workers: [], dispatcherBusy: true }), true);
});

test('awake: with the setting off nothing keeps the computer awake', () => {
  assert.equal(shouldStayAwake({ on: false, workers: ws('running'), dispatcherBusy: true }), false);
});

function fakeBlocker() {
  const calls: string[] = [];
  let next = 1;
  return { calls, start: () => { calls.push('start'); return next++; }, stop: (id: number) => { calls.push(`stop ${id}`); } };
}

test('awake: the holder starts one blocker and stops it once', () => {
  const b = fakeBlocker();
  const h = awakeHolder(b);
  h.sync(true); h.sync(true);
  assert.equal(h.held, true);
  h.sync(false); h.sync(false); h.release();
  assert.equal(h.held, false);
  assert.deepEqual(b.calls, ['start', 'stop 1']);
});

test('awake: the holder starts a new blocker after the last one stopped, and quitting stops it', () => {
  const b = fakeBlocker();
  const h = awakeHolder(b);
  h.sync(true); h.sync(false); h.sync(true); h.release(); h.release();
  assert.deepEqual(b.calls, ['start', 'stop 1', 'start', 'stop 2']);
});
