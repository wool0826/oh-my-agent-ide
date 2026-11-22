import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addRecent, completeRepo, recentStep } from '../src/shared/quickInput';

const repos = ['billing', 'billing-web', 'docs'];

test('an @word at the caret becomes the repository it starts', () => {
  assert.deepEqual(completeRepo('fix tax in @bi', 14, repos), { repo: 'billing', text: 'fix tax in @billing ', caret: 20 });
  assert.deepEqual(completeRepo('@do update the guide', 3, repos), { repo: 'docs', text: '@docs update the guide', caret: 6 });
  assert.equal(completeRepo('@billing-', 9, repos)?.repo, 'billing-web');
  assert.equal(completeRepo('@', 1, repos)?.repo, 'docs');
});

test('nothing is offered without an @word, a match, or anything left to add', () => {
  assert.equal(completeRepo('fix tax in bi', 13, repos), null);
  assert.equal(completeRepo('mail me@bi', 10, repos), null);
  assert.equal(completeRepo('@zzz', 4, repos), null);
  assert.equal(completeRepo('@docs', 5, repos), null);
  assert.equal(completeRepo('@bi and more', 12, repos), null);
});

test('sent lines are kept newest first, once each, up to the limit', () => {
  assert.deepEqual(addRecent(['b', 'a'], 'a'), ['a', 'b']);
  assert.deepEqual(addRecent(['b'], '  '), ['b']);
  assert.deepEqual(addRecent(['3', '2', '1'], '4', 3), ['4', '3', '2']);
});

test('the arrow keys go back through sent lines and return to the line being typed', () => {
  assert.equal(recentStep(3, -1, 'up'), 0);
  assert.equal(recentStep(3, 2, 'up'), 2);
  assert.equal(recentStep(3, 0, 'down'), -1);
  assert.equal(recentStep(3, -1, 'down'), -1);
  assert.equal(recentStep(0, -1, 'up'), -1);
});
