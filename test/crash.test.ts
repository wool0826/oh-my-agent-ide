import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  crashEntry, faultAction, faultMessage, markerText, previousRun, relaunchArgs, relaunchedAt, rendererAction, rendererDied,
  RELAUNCH_GUARD_MS, REPEAT_MS,
} from '../src/shared/crash';

const NOW = 10_000_000;

test('an unhandled rejection never stops the app', () => {
  assert.equal(faultAction('rejection', [], NOW, null), 'continue');
  assert.equal(faultAction('rejection', [NOW - 1000, NOW - 500], NOW, NOW - 1000), 'continue');
});

test('a first uncaught exception keeps running; a repeat within a minute relaunches', () => {
  assert.equal(faultAction('exception', [], NOW, null), 'continue');
  assert.equal(faultAction('exception', [NOW - REPEAT_MS], NOW, null), 'continue');
  assert.equal(faultAction('exception', [NOW - REPEAT_MS + 1], NOW, null), 'relaunch');
  assert.equal(faultAction('exception', [NOW - 3 * REPEAT_MS, NOW - 1000], NOW, null), 'relaunch');
});

test('a repeat soon after a crash relaunch quits, so a crash loop ends', () => {
  assert.equal(faultAction('exception', [NOW - 1000], NOW, NOW - 30_000), 'quit');
  assert.equal(faultAction('exception', [NOW - 1000], NOW, NOW - RELAUNCH_GUARD_MS), 'relaunch');
  // A single exception after a relaunch still keeps running.
  assert.equal(faultAction('exception', [], NOW, NOW - 1000), 'continue');
});

test('the window page is reloaded twice in a minute, then left closed', () => {
  assert.equal(rendererAction([], NOW), 'reload');
  assert.equal(rendererAction([NOW - 5000], NOW), 'reload');
  assert.equal(rendererAction([NOW - 9000, NOW - 5000], NOW), 'give-up');
  assert.equal(rendererAction([NOW - 120_000, NOW - 5000], NOW), 'reload');
  assert.equal(rendererDied('crashed', false), true);
  assert.equal(rendererDied('killed', false), true);
  assert.equal(rendererDied('clean-exit', false), false);
  assert.equal(rendererDied('crashed', true), false);
});

test('a crash relaunch passes its time to the next run, once', () => {
  const args = relaunchArgs(['.', '--hidden', '--relaunched-at=5'], 900);
  assert.deepEqual(args, ['.', '--hidden', '--relaunched-at=900']);
  assert.equal(relaunchedAt(['electron', ...args]), 900);
  assert.equal(relaunchedAt(['electron', '.']), null);
  assert.equal(relaunchedAt(['--relaunched-at=x']), null);
});

test('the marker: none means the last run quit, any other means it did not', () => {
  assert.equal(previousRun(null), null);
  const m = { pid: 42, startedAt: '2026-11-25T01:00:00.000Z', version: '0.9.0', crash: { at: '2026-11-25T01:02:00.000Z', message: 'Error: boom' } };
  assert.deepEqual(previousRun(markerText(m)), m);
  assert.deepEqual(previousRun(`\uFEFF${markerText({ pid: 7, startedAt: 'a', version: 'b' })}`), { pid: 7, startedAt: 'a', version: 'b' });
  // Cut off mid-write, or empty: still a run that did not quit.
  assert.deepEqual(previousRun('{"pid": 4'), { pid: 0, startedAt: '', version: '' });
  assert.deepEqual(previousRun(''), { pid: 0, startedAt: '', version: '' });
});

test('a crash log entry has the time, the kind and the whole stack', () => {
  const e = new Error('boom');
  const line = crashEntry('exception', e, new Date('2026-11-25T00:00:00Z'));
  assert.match(line, /^2026-11-25T00:00:00\.000Z exception Error: boom\n {4}at /);
  assert.ok(line.endsWith('\n'));
  assert.equal(crashEntry('rejection', { code: 7 }, new Date(0)), '1970-01-01T00:00:00.000Z rejection {"code":7}\n');
  assert.equal(crashEntry('rejection', undefined, new Date(0)), '1970-01-01T00:00:00.000Z rejection undefined\n');
  assert.equal(faultMessage(new TypeError('x is not a function\nmore')), 'TypeError: x is not a function');
});
