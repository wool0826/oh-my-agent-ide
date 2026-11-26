import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findCount, firstFrom, matchRanges, tickAt } from '../src/shared/findMarks';

test('findMarks: every match of every word, ignoring case, in order', () => {
  assert.deepEqual(matchRanges('No pineapple on Fridays. PINEAPPLE!', ['pineapple', 'fridays']), [[3, 12], [16, 23], [25, 34]]);
});

test('findMarks: overlapping words give one match, the longer one where both start', () => {
  assert.deepEqual(matchRanges('pineapple', ['pine', 'pineapple', 'apple']), [[0, 9]]);
});

test('findMarks: Korean text and empty words', () => {
  assert.deepEqual(matchRanges('두 줄로 줄바꿈 되면서', ['줄바꿈', '']), [[5, 8]]);
});

test('findMarks: a character whose lower case is longer does not shift the matches', () => {
  const text = 'İstanbul and Ankara';
  const [r1, r2] = matchRanges(text, ['stanbul', 'ankara']);
  assert.equal(text.slice(...r1), 'stanbul');
  assert.equal(text.slice(...r2), 'Ankara');
});

test('findMarks: the current match is the message first one, else the last', () => {
  assert.equal(firstFrom(5, 2), 2);
  assert.equal(firstFrom(5, -1), 4);
  assert.equal(firstFrom(0, 0), -1);
});

test('findMarks: the count and the tick places', () => {
  assert.equal(findCount(3, 5), '4/5');
  assert.equal(findCount(-1, 0), '0/0');
  assert.equal(tickAt(250, 1000), 25);
  assert.equal(tickAt(2000, 1000), 100);
  assert.equal(tickAt(10, 0), 0);
});
