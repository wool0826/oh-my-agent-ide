import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayWord, keepPick, LIST_W, paneMode, SPLIT_AT } from '../src/shared/insPanes';
import { PANELS } from '../src/shared/panelWidth';

test('paneMode splits from 560 and only with something selected', () => {
  assert.equal(paneMode(PANELS.ins.min, true), 'one');
  assert.equal(paneMode(PANELS.ins.def, true), 'one');
  assert.equal(paneMode(SPLIT_AT - 1, true), 'one');
  assert.equal(paneMode(SPLIT_AT, true), 'split');
  assert.equal(paneMode(PANELS.ins.max, true), 'split');
  assert.equal(paneMode(PANELS.ins.max, false), 'one');
  // The detail pane has room for a card next to the list, inside the sidebar's limits.
  assert.ok(SPLIT_AT - LIST_W >= 272 && SPLIT_AT <= PANELS.ins.max);
});

test('keepPick keeps the selection while it exists', () => {
  assert.equal(keepPick(['a', 'b'], 'b', 'a'), 'b');
  assert.equal(keepPick(['a'], 'b', 'a'), 'a');
  assert.equal(keepPick([], 'b', null), null);
  assert.equal(keepPick(['a'], null, 'new'), 'new');
});

test('dayWord names the days around today in local time', () => {
  const now = new Date(2026, 10, 23, 23, 50);
  assert.equal(dayWord(new Date(2026, 10, 23, 0, 5), now), 'today');
  assert.equal(dayWord(new Date(2026, 10, 24, 0, 5), now), 'tomorrow');
  assert.equal(dayWord(new Date(2026, 10, 22, 9, 0), now), 'yesterday');
  assert.equal(dayWord(new Date(2026, 10, 25, 9, 0), now), 'week');
  assert.equal(dayWord(new Date(2026, 10, 29, 9, 0), now), 'week');
  assert.equal(dayWord(new Date(2026, 10, 30, 9, 0), now), 'date');
  assert.equal(dayWord(new Date(2026, 10, 20, 9, 0), now), 'date');
  // Across a month and a year end.
  assert.equal(dayWord(new Date(2027, 0, 1, 9, 0), new Date(2026, 11, 31, 22, 0)), 'tomorrow');
});
