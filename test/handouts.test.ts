import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handoutCounts, handoutFolded, handoutRuns, handoutSettled, handoutState, isHandout, runTasks, type HandoutItem } from '../src/shared/handouts';

const ev = (id: string, ref?: string): HandoutItem => ({ id, kind: 'event', sub: 'handout', ref });
const line = (id: string, kind = 'event'): HandoutItem => ({ id, kind });

test('isHandout: only tagged events; older untagged lines stay single lines', () => {
  assert.equal(isHandout(ev('a')), true);
  assert.equal(isHandout(line('b')), false);
  assert.equal(isHandout({ id: 'c', kind: 'result', sub: 'handout' }), false);
  assert.equal(isHandout(null), false);
});

test('handoutRuns: the lines of one turn share one run, keyed by its first line; a message of the user ends it', () => {
  const items = [line('u', 'user'), ev('1'), ev('2', 'T-1'), line('d', 'dispatcher'), line('r', 'result'), ev('3'), ev('4', 'T-2'), line('v', 'user'), ev('5', 'T-3'), line('x')];
  const runs = handoutRuns(items);
  assert.deepEqual([...runs.keys()], ['1', '5']);
  assert.deepEqual(runs.get('1')!.map((c) => c.id), ['1', '2', '3', '4']);
  assert.deepEqual(runs.get('5')!.map((c) => c.id), ['5']);
  assert.deepEqual([...handoutFolded(runs)], ['2', '3', '4']);
  assert.equal(handoutRuns([line('a'), line('b')]).size, 0);
});

test('runTasks: each task once, in order; "Created" lines name none', () => {
  assert.deepEqual(runTasks([ev('1'), ev('2', 'T-2'), ev('3', 'T-1'), ev('4', 'T-2')]), ['T-2', 'T-1']);
  assert.deepEqual(runTasks([ev('1')]), []);
});

test('handoutState: what needs the user wins over running; a stop is not a failure', () => {
  const x = (status: Parameters<typeof handoutState>[0]['status'], stopped = false) => ({ status, stopped });
  assert.equal(handoutState(x('running'), false), 'run');
  assert.equal(handoutState(x('waiting'), false), 'run');
  assert.equal(handoutState(x('waiting'), true), 'ask');
  assert.equal(handoutState(x('running'), true), 'ask');
  assert.equal(handoutState(x('queued'), false), 'queued');
  assert.equal(handoutState(x('blocked'), false), 'queued');
  assert.equal(handoutState(x('pr_open'), false), 'done');
  assert.equal(handoutState(x('done'), false), 'done');
  assert.equal(handoutState(x('failed'), false), 'failed');
  assert.equal(handoutState(x('failed', true), false), 'stopped');
  assert.equal(handoutState(x('cancelled'), false), 'stopped');
  // A failed task's leftover decision does not make it look like it waits.
  assert.equal(handoutState(x('failed'), true), 'failed');
});

test('handoutCounts: the states present, what needs the user first', () => {
  assert.deepEqual(handoutCounts(['run', 'ask', 'failed', 'ask', 'done']), [['ask', 2], ['failed', 1], ['run', 1], ['done', 1]]);
  assert.deepEqual(handoutCounts([]), []);
});

test('handoutSettled: folds only when every task is done or stopped', () => {
  assert.equal(handoutSettled(['done', 'stopped', 'done']), true);
  assert.equal(handoutSettled(['done', 'failed']), false);
  assert.equal(handoutSettled(['done', 'run']), false);
  assert.equal(handoutSettled([]), false);
});
