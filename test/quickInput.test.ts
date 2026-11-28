import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addRecent, addSent, completeRepo, filterSent, historyKey, matchParts, opensHistory, recentStep, sentAge } from '../src/shared/quickInput';

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

test('quickInput: a sent prompt goes in front once, at its newest time, within the limit', () => {
  const a = addSent([], 'one', '2026-11-28T01:00:00Z');
  const b = addSent(a, 'two', '2026-11-28T02:00:00Z');
  assert.deepEqual(addSent(b, ' one ', '2026-11-28T03:00:00Z').map((x) => [x.text, x.at]), [['one', '2026-11-28T03:00:00Z'], ['two', '2026-11-28T02:00:00Z']]);
  assert.equal(addSent(b, '   ', '2026-11-28T03:00:00Z').length, 2);
  assert.deepEqual(addSent(b, 'three', 'x', 2).map((x) => x.text), ['three', 'two']);
});

test('quickInput: the history key is the chat or one Worker', () => {
  assert.equal(historyKey(null), 'chat');
  assert.equal(historyKey('W-05'), 'w:W-05');
});

test('quickInput: Up opens the history only from an empty composer', () => {
  assert.equal(opensHistory(''), true);
  assert.equal(opensHistory('  \n'), true);
  assert.equal(opensHistory('fix'), false);
});

test('quickInput: typing keeps the prompts that hold it and marks the match', () => {
  const list = [{ text: 'Run the tests again', at: '' }, { text: 'Write notes', at: '' }, { text: 'test the TEST page', at: '' }];
  assert.deepEqual(filterSent(list, 'test').map((x) => x.text), ['Run the tests again', 'test the TEST page']);
  assert.equal(filterSent(list, ' ').length, 3);
  assert.deepEqual(matchParts('test the TEST page', 'test'), [{ text: 'test', hit: true }, { text: ' the ', hit: false }, { text: 'TEST', hit: true }, { text: ' page', hit: false }]);
  assert.deepEqual(matchParts('first\nsecond', ''), [{ text: 'first', hit: false }]);
});

test('quickInput: a prompt age is now, minutes, hours, yesterday or a date', () => {
  const now = new Date(2026, 10, 28, 15, 0);
  const at = (d: Date) => d.toISOString();
  assert.deepEqual(sentAge(at(new Date(2026, 10, 28, 14, 59, 40)), now), { kind: 'now' });
  assert.deepEqual(sentAge(at(new Date(2026, 10, 28, 14, 10)), now), { kind: 'min', n: 50 });
  assert.deepEqual(sentAge(at(new Date(2026, 10, 28, 13, 0)), now), { kind: 'hour', n: 2 });
  assert.deepEqual(sentAge(at(new Date(2026, 10, 27, 23, 0)), new Date(2026, 10, 28, 2, 0)), { kind: 'hour', n: 3 });
  assert.deepEqual(sentAge(at(new Date(2026, 10, 27, 9, 0)), now), { kind: 'yesterday' });
  assert.deepEqual(sentAge(at(new Date(2026, 10, 25, 9, 0)), now), { kind: 'date', month: 11, day: 25 });
});
