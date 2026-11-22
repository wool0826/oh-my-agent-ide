import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkpointLabel, checkpointPrefix, checkpointsToDrop, parseCheckpoints } from '../src/shared/checkpoints';

test('a checkpoint is named after what the Worker was about to be told', () => {
  assert.equal(checkpointLabel('Add tax to the cart total\n\nDetails follow.'), 'Add tax to the cart total');
  assert.equal(checkpointLabel('[Review comments] New comments on https://x/pull/3. Address them.'), 'New comments on https://x/pull/3. Address them.');
  assert.equal(checkpointLabel('[Reply to W-03]\n> earlier text\n\nUse the helper.'), 'earlier text');
  assert.equal(checkpointLabel('x'.repeat(200)).length, 70);
  assert.equal(checkpointLabel('   '), '');
});

test('each Worker has its own place for refs', () => {
  assert.equal(checkpointPrefix('W-03'), 'refs/oma/checkpoints/W-03/');
});

test('checkpoints are read from git, newest first, with tabs in a subject kept', () => {
  const out = [
    'refs/oma/checkpoints/W-03/1795000002000\t2026-11-22T10:02:00+09:00\ttree2\tFix the\tlabel',
    'refs/oma/checkpoints/W-03/1795000001000\t2026-11-22T10:01:00+09:00\ttree1\tAdd tax',
    '',
    'garbage',
  ].join('\n');
  assert.deepEqual(parseCheckpoints(out), [
    { ref: 'refs/oma/checkpoints/W-03/1795000002000', at: '2026-11-22T10:02:00+09:00', tree: 'tree2', label: 'Fix the\tlabel' },
    { ref: 'refs/oma/checkpoints/W-03/1795000001000', at: '2026-11-22T10:01:00+09:00', tree: 'tree1', label: 'Add tax' },
  ]);
});

test('only the newest are kept', () => {
  const refs = Array.from({ length: 23 }, (_, i) => `r${i}`);
  assert.deepEqual(checkpointsToDrop(refs), ['r20', 'r21', 'r22']);
  assert.deepEqual(checkpointsToDrop(refs.slice(0, 5)), []);
});
