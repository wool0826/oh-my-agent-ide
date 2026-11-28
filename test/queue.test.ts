import { test } from 'node:test';
import assert from 'node:assert/strict';
import { afterDependency, canRerun, parseRerunMode, rerunInput, branchPrDue, byQueue, dropBefore, parseQueueMove, cancelSet, cancelWhy, describeCancel, followersOf, hasOpenPr, isQueued, moveQueued, pickBranchPr, stampQueued, statusAfterCancel, type QueueMove } from '../src/shared/queue';
import { COMPARE_NOTE } from '../src/shared/compare';
import type { Task } from '../src/shared/types';

function task(id: string, patch: Partial<Task> = {}): Task {
  return {
    id, title: `title ${id}`, prompt: '', kind: 'code', repo: 'demo', workerId: 'W-01', status: 'queued',
    branch: `agent/${id.toLowerCase()}`, prUrl: null, prState: null, summary: null, files: [],
    createdAt: '', updatedAt: '', finishedAt: null, reviewSyncedAt: null, seenCommentIds: [], afterTaskId: null,
    ...patch,
  };
}

test('queue: only queued and blocked tasks count as waiting', () => {
  assert.equal(isQueued(task('T-1', { status: 'queued' })), true);
  assert.equal(isQueued(task('T-1', { status: 'blocked' })), true);
  for (const status of ['running', 'waiting', 'pr_open', 'done', 'failed', 'cancelled'] as const) {
    assert.equal(isQueued(task('T-1', { status })), false, status);
  }
});

test('queue: a task that never finished is cancelled', () => {
  assert.equal(statusAfterCancel(task('T-1')), 'cancelled');
  assert.equal(statusAfterCancel(task('T-1', { status: 'blocked' })), 'cancelled');
});

test('queue: queued review or CI work on an open PR goes back to the PR, which stays open', () => {
  const t = task('T-1', { prUrl: 'https://github.com/o/r/pull/7', prState: 'OPEN', finishedAt: '2026-11-20T00:00:00Z' });
  assert.equal(hasOpenPr(t), true);
  assert.equal(statusAfterCancel(t), 'pr_open');
});

test('queue: a queued follow-up on a finished task without a PR keeps the task done', () => {
  assert.equal(statusAfterCancel(task('T-1', { finishedAt: '2026-11-20T00:00:00Z' })), 'done');
  assert.equal(statusAfterCancel(task('T-1', { finishedAt: '2026-11-20T00:00:00Z', prUrl: 'https://github.com/o/r/pull/7', prState: 'MERGED' })), 'done');
});

test('queue: followers are found through chains of waiting tasks, once each', () => {
  const tasks = [
    task('T-1'),
    task('T-2', { status: 'blocked', afterTaskId: 'T-1' }),
    task('T-3', { status: 'blocked', afterTaskId: 'T-2' }),
    task('T-4', { status: 'blocked', afterTaskId: 'T-1' }),
    task('T-5', { status: 'blocked', afterTaskId: 'T-9' }),
    // Already started after its dependency merged: not a follower any more.
    task('T-6', { status: 'running', afterTaskId: 'T-1' }),
  ];
  assert.deepEqual(followersOf(tasks, 'T-1').map((x) => x.id), ['T-2', 'T-3', 'T-4']);
  assert.deepEqual(followersOf(tasks, 'T-2').map((x) => x.id), ['T-3']);
  assert.deepEqual(followersOf(tasks, 'T-5').map((x) => x.id), []);
});

test('queue: cancelSet skips tasks that are not waiting and does not list a picked task as a follower', () => {
  const tasks = [
    task('T-1'),
    task('T-2', { status: 'blocked', afterTaskId: 'T-1' }),
    task('T-3', { status: 'running' }),
  ];
  const one = cancelSet(tasks, ['T-1', 'T-3', 'T-404']);
  assert.deepEqual(one.picked.map((x) => x.id), ['T-1']);
  assert.deepEqual(one.followers.map((x) => x.id), ['T-2']);
  const both = cancelSet(tasks, ['T-1', 'T-2']);
  assert.deepEqual(both.picked.map((x) => x.id), ['T-1', 'T-2']);
  assert.deepEqual(both.followers, []);
});

test('queue: followers keep waiting when the task keeps an open PR', () => {
  const tasks = [
    task('T-1', { prUrl: 'https://github.com/o/r/pull/7', prState: 'OPEN', finishedAt: '2026-11-20T00:00:00Z' }),
    task('T-2', { status: 'blocked', afterTaskId: 'T-1' }),
  ];
  const s = cancelSet(tasks, ['T-1']);
  assert.deepEqual(s.picked.map((x) => x.id), ['T-1']);
  assert.deepEqual(s.followers, []);
});

test('queue: the Dispatcher reads what happened to each task', () => {
  assert.equal(describeCancel({ id: 'T-1', title: 'A', workerId: 'W-01', status: 'cancelled', followerOf: null, kept: null }), 'T-1 "A" cancelled');
  assert.equal(describeCancel({ id: 'T-2', title: 'B', workerId: 'W-01', status: 'cancelled', followerOf: 'T-1', kept: null }), 'T-2 "B" cancelled (it waited for T-1)');
  assert.equal(describeCancel({ id: 'T-3', title: 'C', workerId: 'W-01', status: 'pr_open', followerOf: null, kept: null }), 'T-3 "C" queued work dropped; the task stays pr_open and its PR stays open');
  assert.equal(
    describeCancel({ id: 'T-4', title: 'D', workerId: 'W-01', status: 'cancelled', followerOf: null, kept: { branch: 'agent/t-4', commits: 2, dirty: true, path: '/wt/W-01' } }),
    'T-4 "D" cancelled; branch agent/t-4 kept in /wt/W-01 (2 commit(s), uncommitted changes)',
  );
});

test('queue: a blocked task waits while its dependency runs or has an open PR, starts once it is merged or done without one, and is cancelled otherwise', () => {
  const pr = 'https://github.com/o/r/pull/1';
  for (const status of ['running', 'waiting', 'queued', 'blocked'] as const) assert.equal(afterDependency(task('T-1', { status })), 'wait', status);
  assert.equal(afterDependency(task('T-1', { status: 'pr_open', prUrl: pr, prState: 'OPEN' })), 'wait');
  // A review fix that failed leaves its PR open: still worth waiting for.
  assert.equal(afterDependency(task('T-1', { status: 'failed', prUrl: pr, prState: 'OPEN' })), 'wait');
  assert.equal(afterDependency(task('T-1', { status: 'done', prUrl: pr, prState: 'MERGED' })), 'start');
  assert.equal(afterDependency(task('T-1', { status: 'done' })), 'start');
  assert.equal(afterDependency(task('T-1', { status: 'done', prUrl: pr, prState: 'CLOSED' })), 'cancel');
  assert.equal(afterDependency(task('T-1', { status: 'failed' })), 'cancel');
  assert.equal(afterDependency(task('T-1', { status: 'cancelled' })), 'cancel');
  assert.equal(afterDependency(undefined), 'cancel');
});

test('queue: blocked tasks are cancelled because the task they wait for had its PR closed, is gone, or failed', () => {
  assert.equal(cancelWhy(task('T-1', { prState: 'CLOSED' }), true), 'closed');
  assert.equal(cancelWhy(task('T-1', { prState: 'CLOSED' }), false), 'closed');
  assert.equal(cancelWhy(task('T-1'), false), 'gone');
  assert.equal(cancelWhy(task('T-1', { status: 'failed' }), true), 'failed');
});

/** Four tasks that joined the queue a minute apart, T-1 first; `pins` are pinned. */
function line(pins: string[] = []): Task[] {
  return ['T-1', 'T-2', 'T-3', 'T-4'].map((id, i) => task(id, { queuedSince: `2026-11-28T10:0${i}:00Z`, queuePinned: pins.includes(id) })).sort(byQueue);
}

/** The line after the move, as ids with * on the pinned ones; null when it could not move. */
function moved(l: Task[], id: string, move: QueueMove, held?: Task): string | null {
  const ch = moveQueued(l, id, move, held);
  if (!ch) return null;
  for (const c of ch) Object.assign(l.find((t) => t.id === c.id) ?? held!, { queueRank: c.queueRank, queuePinned: c.queuePinned });
  return l.sort(byQueue).map((t) => t.id + (t.queuePinned ? '*' : '')).join(' ');
}

test('queue order: pinned tasks first, then the longest waiting', () => {
  assert.deepEqual(line(['T-3']).map((t) => t.id), ['T-3', 'T-1', 'T-2', 'T-4']);
});

test('queue order: up and down move one place, and stop at the ends', () => {
  assert.equal(moved(line(), 'T-3', 'up'), 'T-1 T-3 T-2 T-4');
  assert.equal(moved(line(), 'T-3', 'down'), 'T-1 T-2 T-4 T-3');
  assert.equal(moved(line(), 'T-1', 'up'), null);
  assert.equal(moved(line(), 'T-4', 'down'), null);
});

test('queue order: up and top stay below the pinned tasks', () => {
  assert.equal(moved(line(['T-1']), 'T-2', 'up'), null);
  assert.equal(moved(line(['T-1']), 'T-4', 'top'), 'T-1* T-4 T-2 T-3');
});

test('queue order: next goes first of all, pinned when a pinned task was ahead', () => {
  assert.equal(moved(line(), 'T-3', 'next'), 'T-3 T-1 T-2 T-4');
  assert.equal(moved(line(['T-1']), 'T-3', 'next'), 'T-3* T-1* T-2 T-4');
  assert.equal(moved(line(), 'T-1', 'next'), null);
});

test('queue order: pin toggles and puts the task ahead of the others', () => {
  const l = line();
  assert.equal(moved(l, 'T-4', 'pin'), 'T-4* T-1 T-2 T-3');
  assert.equal(moved(l, 'T-4', 'pin'), 'T-1 T-2 T-3 T-4');
});

test('queue order: a dropped task takes the pin of where it lands', () => {
  assert.equal(moved(line(), 'T-4', { before: 'T-2' }), 'T-1 T-4 T-2 T-3');
  assert.equal(moved(line(), 'T-1', { before: null }), 'T-2 T-3 T-4 T-1');
  assert.equal(moved(line(['T-1']), 'T-3', { before: 'T-1' }), 'T-3* T-1* T-2 T-4');
  assert.equal(moved(line(['T-1', 'T-2']), 'T-1', { before: 'T-4' }), 'T-2* T-3 T-1 T-4');
  assert.equal(moved(line(['T-1']), 'T-1', { before: 'T-2' }), null);
  assert.equal(moved(line(), 'T-2', { before: 'T-9' }), null);
});

test('queue order: a task held by a merge can only be pinned', () => {
  const held = task('T-9', { status: 'blocked', queuedSince: '2026-11-28T09:00:00Z' });
  assert.equal(moveQueued(line(), 'T-9', 'up', held), null);
  assert.deepEqual(moveQueued(line(), 'T-9', 'pin', held), [{ id: 'T-9', queueRank: null, queuePinned: true }]);
});

test('queue order: the moved tasks keep the keys the line had, so a task queued later still joins at the back', () => {
  const l = line();
  moved(l, 'T-4', 'top');
  const late = task('T-5', { queuedSince: '2026-11-28T10:09:00Z' });
  assert.deepEqual([...l, late].sort(byQueue).map((t) => t.id), ['T-4', 'T-1', 'T-2', 'T-3', 'T-5']);
});

test('queue order: a task whose merge hold just cleared joins behind the tasks that queued while it waited', () => {
  const freed = task('T-9', { queuedSince: '2026-11-28T09:00:00Z', updatedAt: '2026-11-28T10:30:00Z' });
  assert.deepEqual([freed, ...line()].sort(byQueue).map((t) => t.id), ['T-1', 'T-2', 'T-3', 'T-4', 'T-9']);
});

test('queue order: a task that leaves the queue loses its place and pin', () => {
  const t = task('T-1', { status: 'running', queuedSince: '2026-11-28T10:00:00Z', queueRank: 5, queuePinned: true });
  assert.equal(stampQueued([t]), true);
  assert.equal(t.queueRank, null);
  assert.equal(t.queuePinned, false);
});

test('queue order: a row dropped over the top half of another goes before it, below the last one at the end', () => {
  const rows = [{ id: 'T-1', top: 0, height: 40 }, { id: 'T-2', top: 40, height: 40 }];
  assert.equal(dropBefore(rows, 10), 'T-1');
  assert.equal(dropBefore(rows, 30), 'T-2');
  assert.equal(dropBefore(rows, 70), null);
});

test('queue order: only the moves the queue knows come from the window', () => {
  assert.equal(parseQueueMove('top'), 'top');
  assert.deepEqual(parseQueueMove({ before: 'T-2' }), { before: 'T-2' });
  assert.deepEqual(parseQueueMove({ before: null }), { before: null });
  assert.equal(parseQueueMove('left'), null);
  assert.equal(parseQueueMove({ before: 3 }), null);
  assert.equal(parseQueueMove({}), null);
});

test('branchPrDue: a code task done on a branch with no PR known asks GitHub once before its followers start', () => {
  const done = task('T-1', { status: 'done' });
  assert.equal(branchPrDue(done, false, false), true);
  assert.equal(branchPrDue(done, false, true), false, 'already asked for this finish');
  assert.equal(branchPrDue(done, true, false), false, 'a local-only repository has no PRs');
  assert.equal(branchPrDue({ ...done, prUrl: 'https://github.com/o/r/pull/1' }, false, false), false);
  assert.equal(branchPrDue({ ...done, kind: 'other' }, false, false), false, 'a research task ends without a PR as before');
  assert.equal(branchPrDue({ ...done, branch: null }, false, false), false);
  assert.equal(branchPrDue({ ...done, status: 'failed' }, false, false), false);
});

test('pickBranchPr: an open PR first, then a merged one; a closed one or nothing readable is no PR', () => {
  const open = { url: 'https://github.com/o/r/pull/2', state: 'OPEN' };
  const merged = { url: 'https://github.com/o/r/pull/1', state: 'MERGED' };
  const closed = { url: 'https://github.com/o/r/pull/3', state: 'CLOSED' };
  assert.deepEqual(pickBranchPr([closed, merged, open]), open);
  assert.deepEqual(pickBranchPr([closed, merged]), merged);
  assert.equal(pickBranchPr([closed]), null);
  assert.equal(pickBranchPr(null), null);
  assert.equal(pickBranchPr([{ url: 'not a PR', state: 'OPEN' }]), null);
});

test('rerun: only a task that ended can run again', () => {
  for (const status of ['done', 'failed', 'cancelled', 'pr_open'] as const) assert.equal(canRerun(task('T-1', { status, prompt: 'Do it' })), true, status);
  for (const status of ['queued', 'blocked', 'running', 'waiting'] as const) assert.equal(canRerun(task('T-1', { status, prompt: 'Do it' })), false, status);
  assert.equal(canRerun(task('T-1', { status: 'done', prompt: '  ' })), false);
  assert.equal(canRerun(null), false);
});

test('rerun: again keeps the request and its settings, without its Worker, PR or place', () => {
  const x = task('T-9', { status: 'failed', prompt: 'Fix the window size', effort: 'high', planFirst: true, prUrl: 'https://github.com/o/r/pull/3', queueRank: 4, afterTaskId: 'T-2', bundle: 'b' });
  assert.deepEqual(rerunInput(x, 'again', 'claude-opus-5-5'), {
    title: 'title T-9', prompt: 'Fix the window size', kind: 'code', repo: 'demo', model_id: 'claude-opus-5-5', effort: 'high', plan_first: true, rerun_of: 'T-9',
  });
});

test('rerun: copy asks for a new Worker, and the edited text replaces the request', () => {
  const r = rerunInput(task('T-9', { status: 'done', prompt: 'Old' }), 'copy', null, '  New request  ');
  assert.equal(r.new_worker, true);
  assert.equal(r.prompt, 'New request');
  assert.equal(r.model_id, undefined);
  assert.equal(rerunInput(task('T-9', { status: 'done', prompt: 'Old' }), 'again', null, ' ').prompt, 'Old');
});

test('rerun: a task with no repository runs with none; an attempt of a comparison runs as a plain task', () => {
  assert.equal(rerunInput(task('T-9', { kind: 'other', repo: 'demo', prompt: 'Write' }), 'again', null).repo, undefined);
  const r = rerunInput(task('T-9', { title: 'Speed up start (Opus 5.5)', prompt: `Speed up start\n\n${COMPARE_NOTE}`, compare: { group: 'g' } }), 'again', null);
  assert.equal(r.title, 'Speed up start');
  assert.equal(r.prompt, 'Speed up start');
});

test('rerun: only the two modes pass', () => {
  assert.equal(parseRerunMode('again'), 'again');
  assert.equal(parseRerunMode('copy'), 'copy');
  assert.equal(parseRerunMode('x'), null);
  assert.equal(parseRerunMode(undefined), null);
});
