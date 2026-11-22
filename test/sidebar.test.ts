import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupByRepo, recentlyFinished } from '../src/shared/sidebar';

const w = (id: string, repo: string | null) => ({ id, repo });

test('running Workers are grouped by repository in the order the repositories first appear', () => {
  const groups = groupByRepo([w('W-1', 'ide'), w('W-2', 'memory'), w('W-3', 'ide')], (x) => x.repo);
  assert.deepEqual(groups.map((g) => [g.repo, g.items.map((x) => x.id)]), [['ide', ['W-1', 'W-3']], ['memory', ['W-2']]]);
});

test('work outside a repository is one group, listed last', () => {
  const groups = groupByRepo([w('W-1', null), w('W-2', 'ide'), w('W-3', ''), w('W-4', 'ide')], (x) => x.repo);
  assert.deepEqual(groups.map((g) => [g.repo, g.items.map((x) => x.id)]), [['ide', ['W-2', 'W-4']], [null, ['W-1', 'W-3']]]);
});

test('no items, no groups', () => {
  assert.deepEqual(groupByRepo([], () => 'x'), []);
});

test('the five tasks finished last, newest first', () => {
  const tasks = [1, 2, 3, 4, 5, 6, 7].map((n) => ({ id: `T-${n}`, finishedAt: `2026-11-22T0${n}:00:00Z` }));
  assert.deepEqual(recentlyFinished(tasks).map((x) => x.id), ['T-7', 'T-6', 'T-5', 'T-4', 'T-3']);
  assert.deepEqual(recentlyFinished(tasks, 2).map((x) => x.id), ['T-7', 'T-6']);
});

test('a task without a finish time is left out, and the input is not reordered', () => {
  const tasks = [{ id: 'a', finishedAt: '2026-11-22T01:00:00Z' }, { id: 'b', finishedAt: null }, { id: 'c', finishedAt: '2026-11-22T02:00:00Z' }];
  assert.deepEqual(recentlyFinished(tasks).map((x) => x.id), ['c', 'a']);
  assert.deepEqual(tasks.map((x) => x.id), ['a', 'b', 'c']);
});
