import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PR_POLL, eachLimited, isFullRound, isRateLimited, nextPollDelay, prStateQueries, readPrStates } from '../src/shared/prPoll';

test('prPoll: fast while a PR is watched, slow with nothing to watch', () => {
  assert.equal(nextPollDelay(true, 0), PR_POLL.fast);
  assert.equal(nextPollDelay(false, 0), PR_POLL.slow);
  assert.ok(PR_POLL.fast <= 30_000);
});

test('prPoll: failed rounds in a row back off, up to the maximum', () => {
  assert.equal(nextPollDelay(true, 1), PR_POLL.fast * 2);
  assert.equal(nextPollDelay(true, 2), PR_POLL.fast * 4);
  assert.equal(nextPollDelay(true, 20), PR_POLL.max);
  // Never sooner than the slow pace when nothing is watched.
  assert.equal(nextPollDelay(false, 1), PR_POLL.slow);
  assert.equal(nextPollDelay(false, 20), PR_POLL.max);
});

test('prPoll: a full round when asked for or when the last one is old enough', () => {
  const now = 1_000_000;
  assert.equal(isFullRound(now, now - 1000, false), false);
  assert.equal(isFullRound(now, now - 1000, true), true);
  assert.equal(isFullRound(now, now - PR_POLL.full, false), true);
  assert.equal(isFullRound(now, 0, false), true);
});

test('prPoll: rate limits are told apart from other gh errors', () => {
  assert.ok(isRateLimited('GraphQL: API rate limit exceeded for user ID 1.'));
  assert.ok(isRateLimited('HTTP 403: You have exceeded a secondary rate limit.'));
  assert.ok(!isRateLimited('Could not resolve to a PullRequest with the number of 9.'));
});

test('prPoll: one query per host reads every PR, grouped by repository', () => {
  const qs = prStateQueries([
    'https://github.com/o/a/pull/1', 'https://github.com/o/a/pull/2', 'https://github.com/o/b/pull/7',
    'https://github.com/o/a/pull/1', 'https://ghe.example.com/x/y/pull/3', 'https://github.com/o/bad"name/pull/4', 'not a url',
  ]);
  assert.deepEqual(qs.map((q) => q.host), ['github.com', 'ghe.example.com']);
  const gh = qs[0];
  assert.equal(gh.query, 'query { r0: repository(owner: "o", name: "a") { p1: pullRequest(number: 1) { state headRefName } p2: pullRequest(number: 2) { state headRefName } } r1: repository(owner: "o", name: "b") { p7: pullRequest(number: 7) { state headRefName } } }');
  assert.deepEqual([...gh.keys.keys()], ['r0.p1', 'r0.p2', 'r1.p7']);

  const out = readPrStates(JSON.stringify({ data: { r0: { p1: { state: 'MERGED', headRefName: 'agent/t-1' }, p2: { state: 'OPEN', headRefName: 'b' } }, r1: { p7: null } } }), gh.keys);
  assert.deepEqual(Object.fromEntries(out!), {
    'https://github.com/o/a/pull/1': { state: 'MERGED', headRefName: 'agent/t-1' },
    'https://github.com/o/a/pull/2': { state: 'OPEN', headRefName: 'b' },
  });
  assert.equal(readPrStates('[]', gh.keys), null);
  assert.equal(readPrStates('not json', gh.keys), null);
  assert.equal(readPrStates(JSON.stringify({ data: { r0: null } }), gh.keys)!.size, 0);
});

test('prPoll: eachLimited runs at most the limit at once and every item once', async () => {
  let live = 0;
  let most = 0;
  const seen: number[] = [];
  await eachLimited([1, 2, 3, 4, 5, 6, 7], 3, async (x) => {
    live++;
    most = Math.max(most, live);
    await new Promise((r) => setTimeout(r, 5));
    seen.push(x);
    live--;
  });
  assert.equal(most, 3);
  assert.deepEqual(seen.sort(), [1, 2, 3, 4, 5, 6, 7]);
  await eachLimited([], 3, async () => assert.fail('no items'));
});
