import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bundleMergeOrder, bundleName, openBundles } from '../src/shared/bundle';

const ok = { ci: 'passing' as const, failed: [], conflicts: false, review: 'approved' as const };
const task = (id: string, bundle: string | null, status: string, prState: 'OPEN' | 'MERGED' | 'CLOSED' | null, at: number, prChecks: typeof ok | null = ok) =>
  ({ id, bundle, status: status as never, prUrl: prState ? `https://github.com/o/${id}/pull/1` : null, prState, createdAt: `2026-11-22T10:0${at}:00Z`, prChecks });

test('a bundle name is one short line, or nothing', () => {
  assert.equal(bundleName('  rename  the\nAPI '), 'rename the API');
  assert.equal(bundleName(''), null);
  assert.equal(bundleName(3), null);
  assert.equal(bundleName('x'.repeat(100))?.length, 60);
});

test('tasks of one request are grouped in the order they were made', () => {
  const bs = openBundles([task('T-2', 'api', 'pr_open', 'OPEN', 2), task('T-1', 'api', 'pr_open', 'OPEN', 1), task('T-3', null, 'done', null, 3), task('T-4', 'solo', 'running', null, 4)]);
  assert.deepEqual(bs.map((b) => [b.name, b.tasks.map((x) => x.id), b.ready]), [['api', ['T-1', 'T-2'], true]]);
  assert.deepEqual(bundleMergeOrder(bs[0]).map((x) => x.id), ['T-1', 'T-2']);
});

test('a bundle is ready only when every PR left can be merged', () => {
  const ready = (b: ReturnType<typeof task>[]) => openBundles(b)[0]?.ready;
  assert.equal(ready([task('T-1', 'a', 'pr_open', 'OPEN', 1), task('T-2', 'a', 'running', null, 2)]), false);
  assert.equal(ready([task('T-1', 'a', 'pr_open', 'OPEN', 1), task('T-2', 'a', 'pr_open', 'OPEN', 2, { ...ok, conflicts: true })]), false);
  assert.equal(ready([task('T-1', 'a', 'done', 'MERGED', 1), task('T-2', 'a', 'pr_open', 'OPEN', 2)]), true);
});

test('a finished bundle leaves the list', () => {
  assert.deepEqual(openBundles([task('T-1', 'a', 'done', 'MERGED', 1), task('T-2', 'a', 'cancelled', null, 2)]), []);
});
