import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ageMinutes, cardKey, decisionKeys, decisionKind, decisionLate, keepCard, keyAnswer, nextCard, slotClock } from '../src/shared/decisionView';
import { ALLOW, ALLOW_TASK, DENY } from '../src/shared/types';

const T0 = Date.parse('2026-11-23T10:00:00Z');
const min = (n: number) => T0 + n * 60_000;

test('the kind of a decision: a shell line is a command, other permissions stay permissions', () => {
  assert.equal(decisionKind({ source: 'permission', code: '$ npm install csv-stringify' }), 'command');
  assert.equal(decisionKind({ source: 'permission', code: 'src/a.ts' }), 'permission');
  assert.equal(decisionKind({ source: 'permission', code: null }), 'permission');
  assert.equal(decisionKind({ source: 'question', code: null }), 'question');
  assert.equal(decisionKind({ source: 'dispatcher', code: null }), 'question');
  assert.equal(decisionKind({ source: 'plan', code: '# plan' }), 'plan');
});

test('the slot clock counts down while the task waits, then says the slot is given back', () => {
  const since = new Date(T0).toISOString();
  assert.equal(slotClock(null, T0, 10), null);
  assert.equal(slotClock({ status: 'running', waitingSince: since }, T0, 10), null);
  assert.equal(slotClock({ status: 'waiting', waitingSince: since }, min(4), 0), null, 'kept for good: no clock');
  assert.equal(slotClock({ status: 'waiting', waitingSince: null }, T0, 10), null, 'not timed yet');
  assert.deepEqual(slotClock({ status: 'waiting', waitingSince: since }, min(4), 10), { state: 'holding', left: 6 * 60_000, frac: 0.6 });
  assert.deepEqual(slotClock({ status: 'waiting', waitingSince: since }, min(12), 10), { state: 'holding', left: 0, frac: 0 });
  assert.deepEqual(slotClock({ status: 'waiting', waitingSince: since, slotReleased: true }, min(12), 10), { state: 'released' });
});

test('a decision is late near the end of its slot, after it, or after 10 minutes without a clock', () => {
  const at = new Date(T0).toISOString();
  assert.equal(decisionLate(at, { state: 'holding', left: 6, frac: 0.6 }, min(4)), false);
  assert.equal(decisionLate(at, { state: 'holding', left: 2, frac: 0.25 }, min(8)), true);
  assert.equal(decisionLate(at, { state: 'released' }, min(1)), true);
  assert.equal(decisionLate(at, null, min(9)), false);
  assert.equal(decisionLate(at, null, min(10)), true);
  assert.equal(ageMinutes(at, min(4) + 59_000), 4);
  assert.equal(ageMinutes(at, T0 - 5000), 0);
});

test('card keys go by the physical key and ignore composition and modifiers', () => {
  assert.deepEqual(cardKey({ code: 'Enter' }), { act: 'enter' });
  assert.deepEqual(cardKey({ code: 'KeyD' }), { act: 'deny' });
  assert.deepEqual(cardKey({ code: 'KeyT' }), { act: 'task' });
  assert.deepEqual(cardKey({ code: 'Digit3' }), { act: 'pick', n: 3 });
  assert.deepEqual(cardKey({ code: 'Numpad1' }), { act: 'pick', n: 1 });
  assert.deepEqual(cardKey({ code: 'ArrowDown' }), { act: 'next' });
  assert.deepEqual(cardKey({ code: 'ArrowUp' }), { act: 'prev' });
  assert.equal(cardKey({ code: 'Digit0' }), null);
  assert.equal(cardKey({ code: 'KeyD', isComposing: true }), null);
  assert.equal(cardKey({ code: 'KeyD', keyCode: 229 }), null);
  assert.equal(cardKey({ code: 'KeyD', ctrlKey: true }), null);
  assert.equal(cardKey({ code: 'KeyT', metaKey: true }), null);
});

test('what each key answers, and the hints the card shows', () => {
  const perm = { source: 'permission' as const, options: [{ label: ALLOW }, { label: ALLOW_TASK }, { label: DENY }] };
  assert.equal(keyAnswer(perm, { act: 'enter' }), ALLOW);
  assert.equal(keyAnswer(perm, { act: 'deny' }), DENY);
  assert.equal(keyAnswer(perm, { act: 'task' }), ALLOW_TASK);
  assert.equal(keyAnswer({ ...perm, options: [{ label: ALLOW }, { label: DENY }] }, { act: 'task' }), null);
  assert.deepEqual([...decisionKeys(perm)], [[ALLOW, '↵'], [DENY, 'D'], [ALLOW_TASK, 'T']]);
  const q = { source: 'question' as const, options: [{ label: 'Half up' }, { label: 'Bankers' }] };
  assert.equal(keyAnswer(q, { act: 'pick', n: 2 }), 'Bankers');
  assert.equal(keyAnswer(q, { act: 'pick', n: 3 }), null);
  assert.equal(keyAnswer(q, { act: 'enter' }), null);
  assert.equal(keyAnswer(q, { act: 'deny' }), null);
  assert.deepEqual([...decisionKeys(q)], [['Half up', '1'], ['Bankers', '2']]);
  const plan = { source: 'plan' as const, options: [] };
  assert.equal(keyAnswer(plan, { act: 'enter' }), ALLOW);
  assert.equal(keyAnswer(plan, { act: 'deny' }), null);
});

test('moving between cards stops at the ends; an answered card hands the selection to the next one', () => {
  assert.equal(nextCard([], null, 1), null);
  assert.equal(nextCard(['a', 'b', 'c'], null, 1), 'a');
  assert.equal(nextCard(['a', 'b', 'c'], 'a', 1), 'b');
  assert.equal(nextCard(['a', 'b', 'c'], 'c', 1), 'c');
  assert.equal(nextCard(['a', 'b', 'c'], 'a', -1), 'a');
  assert.equal(nextCard(['a', 'b', 'c'], 'gone', -1), 'a');
  assert.equal(keepCard(['a', 'c'], 'c', ['a', 'b', 'c']), 'c');
  assert.equal(keepCard(['a', 'c'], 'b', ['a', 'b', 'c']), 'c');
  assert.equal(keepCard(['a', 'b'], 'c', ['a', 'b', 'c']), 'b');
  // Nothing is selected until the user selects a card: no first card by default.
  assert.equal(keepCard(['x'], null, []), null);
  assert.equal(keepCard(['x', 'y'], null, ['x', 'y']), null);
  assert.equal(keepCard(['x'], 'gone', []), null);
  assert.equal(keepCard([], 'a', ['a']), null);
});
