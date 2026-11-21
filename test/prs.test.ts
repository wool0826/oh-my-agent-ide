import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adoptSeen, byPr, prBusy, prKey, prsInReview, prsToWatch } from '../src/shared/prs';
import type { Task } from '../src/shared/types';

const PR17 = 'https://github.com/wool0826/oh-my-agent-ide/pull/17';

function task(id: string, patch: Partial<Task> = {}): Task {
  return {
    id, title: `title ${id}`, prompt: '', kind: 'code', repo: 'demo', workerId: 'W-21', status: 'pr_open',
    branch: `agent/${id.toLowerCase()}`, prUrl: null, prState: null, summary: null, files: [],
    createdAt: '', updatedAt: '', finishedAt: '2026-11-21T00:00:00Z', reviewSyncedAt: null, seenCommentIds: [], afterTaskId: null,
    ...patch,
  };
}

/** T-0024 opened PR #17; T-0028 resolved its conflicts on the same branch and reported the same URL. */
const opened = (patch: Partial<Task> = {}) => task('T-0024', { title: 'B3: Worker cap', prUrl: PR17, prState: 'OPEN', ...patch });
const followup = (patch: Partial<Task> = {}) => task('T-0028', { title: 'Resolve PR #17 conflicts', prUrl: PR17, prState: 'OPEN', ...patch });

test('prs: the same PR is recognized whatever the scheme, case or trailing path', () => {
  assert.equal(prKey(PR17), 'github.com/wool0826/oh-my-agent-ide/17');
  assert.equal(prKey('http://GitHub.com/Wool0826/Oh-My-Agent-IDE/pull/17/files'), prKey(PR17));
  assert.equal(prKey(`${PR17}#issuecomment-1`), prKey(PR17));
  assert.notEqual(prKey('https://github.com/wool0826/oh-my-agent-ide/pull/170'), prKey(PR17));
  assert.notEqual(prKey('https://github.company.com/wool0826/oh-my-agent-ide/pull/17'), prKey(PR17));
});

test('prs: tasks are grouped by PR in the order given, and tasks without a PR are left out', () => {
  const other = task('T-0030', { prUrl: 'https://github.com/o/r/pull/3', prState: 'OPEN' });
  const groups = [...byPr([opened(), task('T-0025'), other, followup({ prUrl: `${PR17}/files` })]).values()];
  assert.deepEqual(groups.map((g) => g.map((x) => x.id)), [['T-0024', 'T-0028'], ['T-0030']]);
});

test('prs: a PR two tasks recorded is one row in review, under the task that opened it', () => {
  const rows = prsInReview([opened(), followup(), task('T-0030', { prUrl: 'https://github.com/o/r/pull/3', prState: 'OPEN' })]);
  assert.deepEqual(rows.map((x) => x.id), ['T-0024', 'T-0030']);
});

test('prs: a PR some task is working on again is not in review, like a single task fixing comments', () => {
  for (const status of ['running', 'waiting', 'queued'] as const) {
    assert.deepEqual(prsInReview([opened(), followup({ status })]), [], `follow-up ${status}`);
    assert.deepEqual(prsInReview([opened({ status })]), [], `single task ${status}`);
  }
  // The task that opened it failed on later work: the follow-up still shows the PR.
  assert.deepEqual(prsInReview([opened({ status: 'failed' }), followup()]).map((x) => x.id), ['T-0028']);
});

test('prs: merged or closed PRs are not in review', () => {
  assert.deepEqual(prsInReview([opened({ status: 'done', prState: 'MERGED' }), followup({ status: 'done', prState: 'MERGED' })]), []);
  assert.deepEqual(prsInReview([task('T-1', { status: 'done' })]), []);
});

test('prs: the monitor checks each PR once, first task first, and finished tasks only count for history', () => {
  const watches = prsToWatch([opened(), followup(), task('T-0025', { status: 'done' })]);
  assert.equal(watches.length, 1);
  assert.equal(watches[0].url, PR17);
  assert.deepEqual(watches[0].tasks.map((x) => x.id), ['T-0024', 'T-0028']);
  assert.equal(watches[0].announced, false);

  // A task fixing review comments is still checked, so a merge is noticed; a paused one is not.
  const w2 = prsToWatch([opened({ status: 'queued' }), followup({ status: 'running' })]);
  assert.deepEqual(w2[0].tasks.map((x) => x.id), ['T-0028']);
  assert.deepEqual(w2[0].all.map((x) => x.id), ['T-0024', 'T-0028']);
  assert.equal(prBusy(w2[0].all), true);
  assert.equal(prBusy([opened(), followup()]), false);
});

test('prs: a PR another task already saw merged settles quietly, and a fully settled PR is not checked', () => {
  const w = prsToWatch([opened({ status: 'done', prState: 'MERGED' }), followup()]);
  assert.deepEqual(w[0].tasks.map((x) => x.id), ['T-0028']);
  assert.equal(w[0].announced, true);
  assert.deepEqual(prsToWatch([opened({ status: 'done', prState: 'MERGED' }), followup({ status: 'done', prState: 'MERGED' })]), []);
});

test('prs: the task that opened the PR takes over what a follow-up already handled', () => {
  const first = opened({ seenCommentIds: ['c:1'], seenCiRuns: ['run:1'] });
  const later = followup({ seenCommentIds: ['c:1', 'c:2'], seenCiRuns: ['run:2'], ciFixAttempts: 2 });
  adoptSeen(first, [first, later]);
  assert.deepEqual(first.seenCommentIds, ['c:1', 'c:2']);
  assert.deepEqual(first.seenCiRuns, ['run:1', 'run:2']);
  assert.equal(first.ciFixAttempts, 2);
  assert.deepEqual(later.seenCommentIds, ['c:1', 'c:2'], 'the follow-up is not changed');

  // "Keep fixing" reset the owner's count; a follow-up's older count does not undo that.
  first.ciFixAttempts = 0;
  adoptSeen(first, [first, later]);
  assert.equal(first.ciFixAttempts, 0);

  // Nothing handled yet: fields saved before CI tracking stay unset.
  const fresh = opened();
  adoptSeen(fresh, [fresh, followup()]);
  assert.deepEqual(fresh.seenCommentIds, []);
  assert.equal(fresh.seenCiRuns, undefined);
  assert.equal(fresh.ciFixAttempts, undefined);
});
