import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messageTab, rovingIndex, sameMessage, threadIndex } from '../src/shared/roving';
import { typedTime } from '../src/shared/notifyRules';

test('the arrows go round a tab list, and Home and End to its ends', () => {
  assert.equal(rovingIndex(0, 'ArrowRight', 3), 1);
  assert.equal(rovingIndex(2, 'ArrowRight', 3), 0);
  assert.equal(rovingIndex(0, 'ArrowLeft', 3), 2);
  assert.equal(rovingIndex(1, 'Home', 3), 0);
  assert.equal(rovingIndex(1, 'End', 3), 2);
});

test('↑ and ↓ move among choices, not among tabs', () => {
  assert.equal(rovingIndex(0, 'ArrowDown', 3), null);
  assert.equal(rovingIndex(0, 'ArrowUp', 3), null);
  assert.equal(rovingIndex(0, 'ArrowDown', 3, true), 1);
  assert.equal(rovingIndex(0, 'ArrowUp', 3, true), 2);
});

test('a key that is not one of them, or a list of nothing, is left alone', () => {
  assert.equal(rovingIndex(0, 'Enter', 3), null);
  assert.equal(rovingIndex(0, 'a', 3, true), null);
  assert.equal(rovingIndex(0, 'ArrowRight', 0), null);
  assert.equal(threadIndex(0, 'ArrowDown', 0), null);
  assert.equal(threadIndex(0, 'ArrowRight', 5), null);
});

test('a choice that is not in the list starts from the nearer end', () => {
  assert.equal(rovingIndex(-1, 'ArrowRight', 3), 0);
  assert.equal(rovingIndex(-1, 'ArrowLeft', 3), 2);
});

test('↑ and ↓ stop at the ends of a conversation', () => {
  assert.equal(threadIndex(2, 'ArrowUp', 5), 1);
  assert.equal(threadIndex(0, 'ArrowUp', 5), 0);
  assert.equal(threadIndex(3, 'ArrowDown', 5), 4);
  assert.equal(threadIndex(4, 'ArrowDown', 5), 4);
  assert.equal(threadIndex(2, 'Home', 5), 0);
  assert.equal(threadIndex(2, 'End', 5), 4);
});

test('Tab goes through a message and then leaves the conversation', () => {
  // From the message itself, through its two controls, and out.
  assert.equal(messageTab(-1, 2, false), 0);
  assert.equal(messageTab(0, 2, false), 1);
  assert.equal(messageTab(1, 2, false), 'out');
  // A message with nothing in it is left at once.
  assert.equal(messageTab(-1, 0, false), 'out');
  // Backwards: the controls, the message, and out.
  assert.equal(messageTab(1, 2, true), 0);
  assert.equal(messageTab(0, 2, true), -1);
  assert.equal(messageTab(-1, 2, true), 'out');
});

test('the focus stays on its message when the conversation is drawn again', () => {
  // New messages at the end: the same place from the start.
  assert.equal(sameMessage(2, 5, 7, false), 2);
  // An earlier page above: the same place from the end.
  assert.equal(sameMessage(2, 5, 9, true), 6);
  // Fewer messages than before: the nearest one left.
  assert.equal(sameMessage(4, 5, 3, false), 2);
  assert.equal(sameMessage(0, 5, 2, true), 0);
  assert.equal(sameMessage(0, 5, 0, false), -1);
});

test('a time that does not read as one keeps the one in use', () => {
  assert.equal(typedTime('7', '22:00'), '07:00');
  assert.equal(typedTime('23:30', '22:00'), '23:30');
  assert.equal(typedTime('late', '22:00'), '22:00');
  assert.equal(typedTime('25:00', '22:00'), '22:00');
  assert.equal(typedTime('late', ''), '');
  // Emptied on purpose: the hours are off.
  assert.equal(typedTime('  ', '22:00'), '');
});
