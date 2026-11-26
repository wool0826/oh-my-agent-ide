import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openWork, turnOutcome, type TurnEnd } from '../src/shared/turnOutcome';

const end = (over: Partial<TurnEnd> = {}): TurnEnd => ({
  reported: false, blocked: false, background: false, said: true, questioned: false, reminded: false, openWork: false, ...over,
});

test('turnOutcome: a RESULT line finishes the task, whatever else is open', () => {
  assert.equal(turnOutcome(end({ reported: true, openWork: true, background: true })), 'finish');
});

test('turnOutcome: a turn that said nothing never finishes the task, reminded or not (T-0134)', () => {
  assert.equal(turnOutcome(end({ said: false })), 'wait');
  assert.equal(turnOutcome(end({ said: false, reminded: true })), 'wait');
});

test('turnOutcome: background work still running keeps the task open', () => {
  assert.equal(turnOutcome(end({ background: true })), 'wait');
});

test('turnOutcome: BLOCKED or an open request waits for the Dispatcher', () => {
  assert.equal(turnOutcome(end({ blocked: true })), 'ask');
});

test('turnOutcome: the turn after a question is told to go on', () => {
  assert.equal(turnOutcome(end({ questioned: true })), 'goOn');
  assert.equal(turnOutcome(end({ questioned: true, said: false })), 'goOn');
});

test('turnOutcome: text without RESULT is reminded once, then finishes the task', () => {
  assert.equal(turnOutcome(end()), 'remind');
  assert.equal(turnOutcome(end({ reminded: true })), 'finish');
});

test('turnOutcome: after the reminder, open work (steps left, a PR not merged) keeps the task open', () => {
  assert.equal(turnOutcome(end({ reminded: true, openWork: true })), 'wait');
});

test('openWork: a step not done or an unmerged PR is open work; all steps done and no PR is not', () => {
  const step = (done: boolean) => ({ title: 's', doneAt: done ? '2026-11-26T00:00:00Z' : null });
  assert.equal(openWork({ steps: [step(true), step(false)], prUrl: null, prState: null }), true);
  assert.equal(openWork({ steps: [step(true)], prUrl: 'https://github.com/o/r/pull/1', prState: 'OPEN' }), true);
  assert.equal(openWork({ steps: [step(true)], prUrl: 'https://github.com/o/r/pull/1', prState: 'MERGED' }), false);
  assert.equal(openWork({ steps: null, prUrl: null, prState: null }), false);
});
