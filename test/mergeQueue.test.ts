import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MERGE_QUEUE, enqueue, headEntry, inPhase, leave, leftKey, leftNote, merged, nextStep, phaseKey, prune, queueRows, queuedPrs, readyToQueue, removeEntry, tickAfter, updating, type QueueFacts } from '../src/shared/mergeQueue';
import { tr } from '../src/shared/i18n';
import type { MergeQueueEntry, PrChecks, Task } from '../src/shared/types';

const NOW = '2026-11-26T10:00:00.000Z';
const at = (ms: number) => Date.parse(NOW) + ms;
const ok: PrChecks = { ci: 'passing', failed: [], conflicts: false, review: null };
const pr = (n: number, repo = 'demo') => `https://github.com/o/${repo}/pull/${n}`;
const task = (n: number, more: Record<string, unknown> = {}) => ({
  id: `T-${n}`, title: `Change ${n}`, repo: 'demo', workerId: `W-${n}`, prUrl: pr(n) as string | null, prState: 'OPEN' as Task['prState'], status: 'pr_open' as Task['status'],
  createdAt: `2026-11-26T09:0${n}:00.000Z`, bundle: null as string | null, prChecks: ok as PrChecks | null, ...more,
});
const tasks = [task(1), task(2), task(3)];
const entry = (more: Partial<MergeQueueEntry> = {}): MergeQueueEntry => ({ taskId: 'T-1', prUrl: pr(1), phase: 'waiting', since: NOW, ...more });
const facts = (more: Partial<QueueFacts> = {}): QueueFacts => ({ state: 'OPEN', headSha: 'aaa', behind: 0, mergeable: 'MERGEABLE', checks: ok, busy: false, ...more });
const ids = (q: readonly MergeQueueEntry[]) => q.map((e) => `${e.taskId}${e.left ? `:${e.left.why}` : ''}`);

test('mergeQueue: PRs join at the back in the order given, each PR once', () => {
  const q = enqueue([], tasks, ['T-2', 'T-1', 'T-2'], NOW);
  assert.deepEqual(ids(q), ['T-2', 'T-1']);
  assert.deepEqual(q[0], { taskId: 'T-2', prUrl: pr(2), group: null, phase: 'waiting', since: NOW });
  assert.deepEqual(ids(enqueue(q, tasks, ['T-1', 'T-3'], NOW)), ['T-2', 'T-1', 'T-3']);
});

test('mergeQueue: a task without an open PR, or unknown, does not join', () => {
  const list = [task(1, { prState: 'MERGED' }), task(2, { prUrl: null }), task(3)];
  assert.deepEqual(ids(enqueue([], list, ['T-1', 'T-2', 'T-9', 'T-3'], NOW)), ['T-3']);
});

test('mergeQueue: a follow-up task on a PR already in line does not add it twice', () => {
  const list = [task(1), task(2, { prUrl: pr(1).toUpperCase() })];
  assert.deepEqual(ids(enqueue([], list, ['T-1', 'T-2'], NOW)), ['T-1']);
});

test('mergeQueue: a PR that left comes back at the back when added again', () => {
  const q = leave(enqueue([], tasks, ['T-1', 'T-2'], NOW), 'T-1', 'ciFailed', NOW);
  assert.deepEqual(ids(q), ['T-1:ciFailed', 'T-2']);
  const again = enqueue(q, tasks, ['T-1'], NOW);
  assert.deepEqual(ids(again), ['T-2', 'T-1']);
  assert.equal(again[1].left, undefined);
});

test('mergeQueue: the PRs of a bundle keep the order their tasks were made in', () => {
  const list = [task(1, { bundle: 'rename' }), task(2), task(3, { bundle: 'rename' })];
  // Added last-made first, around a PR of no bundle: the bundle's two swap places, the other keeps its own.
  assert.deepEqual(ids(enqueue([], list, ['T-3', 'T-2', 'T-1'], NOW)), ['T-1', 'T-2', 'T-3']);
});

test('mergeQueue: the front is the first PR still in line', () => {
  const q = leave(enqueue([], tasks, ['T-1', 'T-2'], NOW), 'T-1', 'conflict', NOW);
  assert.equal(headEntry(q)?.taskId, 'T-2');
  assert.deepEqual([...queuedPrs(q)], [pr(2)]);
  assert.equal(headEntry(leave(q, 'T-2', 'ciFailed', NOW)), null);
});

test('mergeQueue: a PR that leaves keeps its reason, and the rest stay in line', () => {
  const q = leave(enqueue([], tasks, ['T-1', 'T-2', 'T-3'], NOW), 'T-2', 'mergeFailed', NOW, 'not allowed');
  assert.deepEqual(ids(q), ['T-1', 'T-2:mergeFailed', 'T-3']);
  assert.deepEqual(q[1].left, { why: 'mergeFailed', at: NOW, detail: 'not allowed' });
});

test('mergeQueue: when a bundle\'s PR leaves, its later PRs leave with it and earlier ones stay', () => {
  const list = [task(1, { bundle: 'b' }), task(2, { bundle: 'b' }), task(3), task(4, { bundle: 'b' })];
  const q = enqueue([], list, ['T-1', 'T-2', 'T-3', 'T-4'], NOW);
  assert.deepEqual(ids(leave(q, 'T-2', 'ciFailed', NOW)), ['T-1', 'T-2:ciFailed', 'T-3', 'T-4:bundle']);
});

test('mergeQueue: taking a PR out removes it, and stops the later PRs of its bundle', () => {
  const list = [task(1, { bundle: 'b' }), task(2, { bundle: 'b' }), task(3)];
  const q = enqueue([], list, ['T-1', 'T-2', 'T-3'], NOW);
  assert.deepEqual(ids(removeEntry(q, 'T-1', NOW)), ['T-2:bundle', 'T-3']);
  assert.deepEqual(ids(removeEntry(q, 'T-3', NOW)), ['T-1', 'T-2']);
});

test('mergeQueue: clearing the line of a PR that left changes nothing else', () => {
  const list = [task(1, { bundle: 'b' }), task(2, { bundle: 'b' })];
  const q = leave(enqueue([], list, ['T-1'], NOW), 'T-1', 'ciFailed', NOW);
  const later = enqueue(q, list, ['T-2'], NOW);
  assert.deepEqual(ids(removeEntry(later, 'T-1', NOW)), ['T-2']);
});

test('mergeQueue: a merged PR\'s entry goes; a closed one goes and stops its bundle', () => {
  const list = [task(1, { bundle: 'b' }), task(2, { bundle: 'b' }), task(3)];
  const q = enqueue([], list, ['T-1', 'T-2', 'T-3'], NOW);
  assert.equal(prune(q, list, NOW), q);
  assert.deepEqual(ids(merged(q, 'T-1')), ['T-2', 'T-3']);
  assert.deepEqual(ids(prune(q, [task(1, { prState: 'MERGED' }), list[1], list[2]], NOW)), ['T-2', 'T-3']);
  assert.deepEqual(ids(prune(q, [task(1, { prState: 'CLOSED' }), list[1], list[2]], NOW)), ['T-2:bundle', 'T-3']);
  assert.deepEqual(ids(prune(q, [list[0], list[2]], NOW)), ['T-1', 'T-3']);
});

test('mergeQueue: a PR on its base with passing checks is merged', () => {
  assert.deepEqual(nextStep(entry(), facts(), at(0)), { do: 'merge' });
  // A repository with no checks at all has nothing to wait for.
  assert.deepEqual(nextStep(entry(), facts({ checks: { ...ok, ci: 'none' } }), at(0)), { do: 'merge' });
});

test('mergeQueue: a PR behind its base takes the base first', () => {
  assert.deepEqual(nextStep(entry(), facts({ behind: 2 }), at(0)), { do: 'update' });
});

test('mergeQueue: after the base was asked in, it waits for the branch to move, then for the new head\'s checks', () => {
  const e = updating(entry(), facts(), NOW);
  assert.deepEqual(e, { taskId: 'T-1', prUrl: pr(1), phase: 'updating', since: NOW, updatedFrom: 'aaa', updates: 1, expectChecks: true });
  // Still the old head: its passing checks do not count.
  assert.deepEqual(nextStep(e, facts({ behind: 1 }), at(1000)), { do: 'wait', phase: 'updating' });
  assert.deepEqual(nextStep(e, facts({ behind: 1 }), at(MERGE_QUEUE.headMoves + 1)), { do: 'leave', why: 'updateFailed' });
  // The new head, before its checks were registered: not "nothing to pass".
  const none = facts({ headSha: 'bbb', checks: { ...ok, ci: 'none' } });
  assert.deepEqual(nextStep(e, none, at(1000)), { do: 'wait', phase: 'checks' });
  const waiting = inPhase(e, 'checks', NOW);
  assert.deepEqual(nextStep(waiting, none, at(MERGE_QUEUE.checksAppear + 1)), { do: 'leave', why: 'timeout' });
  assert.deepEqual(nextStep(waiting, facts({ headSha: 'bbb', checks: { ...ok, ci: 'pending' } }), at(MERGE_QUEUE.checksAppear + 1)), { do: 'wait', phase: 'checks' });
  assert.deepEqual(nextStep(waiting, facts({ headSha: 'bbb' }), at(2000)), { do: 'merge' });
});

test('mergeQueue: a PR that never had checks is merged as soon as the base is in', () => {
  const e = updating(entry(), facts({ checks: { ...ok, ci: 'none' } }), NOW);
  assert.equal(e.expectChecks, false);
  assert.deepEqual(nextStep(e, facts({ headSha: 'bbb', checks: { ...ok, ci: 'none' } }), at(1000)), { do: 'merge' });
});

test('mergeQueue: a time limit counts from when its phase began, not from an earlier one', () => {
  // The update took long (the app was closed); the wait for checks starts when the new head is seen.
  const e = updating(entry(), facts(), NOW);
  const late = at(MERGE_QUEUE.checksMax * 2);
  assert.deepEqual(nextStep(e, facts({ headSha: 'bbb', checks: { ...ok, ci: 'pending' } }), late), { do: 'wait', phase: 'checks' });
  assert.equal(inPhase(e, 'checks', '2026-11-26T12:00:00.000Z').since, '2026-11-26T12:00:00.000Z');
  assert.equal(inPhase(e, 'updating', '2026-11-26T12:00:00.000Z'), e);
});

test('mergeQueue: checks that fail after the base was taken put the PR out', () => {
  const e = inPhase(updating(entry(), facts(), NOW), 'checks', NOW);
  assert.deepEqual(nextStep(e, facts({ headSha: 'bbb', checks: { ...ok, ci: 'failing', failed: ['test'] } }), at(1000)), { do: 'leave', why: 'ciFailed' });
});

test('mergeQueue: running checks are waited for, up to the limit', () => {
  const e = entry({ phase: 'checks' });
  const pending = facts({ checks: { ...ok, ci: 'pending' } });
  assert.deepEqual(nextStep(e, pending, at(60_000)), { do: 'wait', phase: 'checks' });
  assert.deepEqual(nextStep(e, pending, at(MERGE_QUEUE.checksMax + 1)), { do: 'leave', why: 'timeout' });
});

test('mergeQueue: a conflict, a review, or a Worker at work puts the PR out', () => {
  assert.deepEqual(nextStep(entry(), facts({ mergeable: 'CONFLICTING', checks: { ...ok, conflicts: true } }), at(0)), { do: 'leave', why: 'conflict' });
  assert.deepEqual(nextStep(entry(), facts({ checks: { ...ok, review: 'changes' } }), at(0)), { do: 'leave', why: 'changes' });
  assert.deepEqual(nextStep(entry(), facts({ checks: { ...ok, review: 'required' } }), at(0)), { do: 'leave', why: 'review' });
  assert.deepEqual(nextStep(entry(), facts({ busy: true }), at(0)), { do: 'leave', why: 'worker' });
});

test('mergeQueue: while GitHub works out whether it merges, or the base could not be read, it waits', () => {
  assert.deepEqual(nextStep(entry(), facts({ mergeable: 'UNKNOWN' }), at(0)), { do: 'wait', phase: 'checks' });
  assert.deepEqual(nextStep(entry(), facts({ behind: null }), at(0)), { do: 'wait', phase: 'checks' });
});

test('mergeQueue: a base that keeps moving is taken a few times, then the PR is put out', () => {
  assert.deepEqual(nextStep(entry({ phase: 'checks', updates: MERGE_QUEUE.maxUpdates - 1 }), facts({ behind: 1 }), at(0)), { do: 'update' });
  assert.deepEqual(nextStep(entry({ phase: 'checks', updates: MERGE_QUEUE.maxUpdates }), facts({ behind: 1 }), at(0)), { do: 'leave', why: 'baseMoved' });
});

test('mergeQueue: a PR already merged or closed is not acted on', () => {
  assert.deepEqual(nextStep(entry({ phase: 'merging' }), facts({ state: 'MERGED' }), at(0)), { do: 'done' });
  assert.deepEqual(nextStep(entry(), facts({ state: 'CLOSED' }), at(0)), { do: 'gone' });
});

test('mergeQueue: after a restart the step comes from what GitHub says now, whatever phase was saved', () => {
  // Stopped in the middle of the merge, and it did not go through: the same check, then the merge again.
  assert.deepEqual(nextStep(entry({ phase: 'merging' }), facts(), at(0)), { do: 'merge' });
  assert.deepEqual(nextStep(entry({ phase: 'merging' }), facts({ behind: 1 }), at(0)), { do: 'update' });
  // Stopped while the base was being taken, and the branch did move meanwhile.
  assert.deepEqual(nextStep(updating(entry(), facts(), NOW), facts({ headSha: 'bbb', checks: { ...ok, ci: 'pending' } }), at(0)), { do: 'wait', phase: 'checks' });
});

test('mergeQueue: the rows are the PRs in line, numbered, then the ones that left', () => {
  const list = [task(1), task(2, { prChecks: { ...ok, ci: 'failing' } }), task(3, { bundle: 'b' })];
  const q = leave(inPhaseAt(enqueue([], list, ['T-2', 'T-1', 'T-3'], NOW), 'T-1', 'checks'), 'T-2', 'ciFailed', NOW, 'test');
  const rows = queueRows(q, list);
  assert.deepEqual(rows.map((r) => [r.taskId, r.pos, r.state, r.why, r.again]), [['T-1', 1, 'checks', null, false], ['T-3', 2, 'waiting', null, false], ['T-2', null, 'left', 'ciFailed', false]]);
  assert.deepEqual([rows[0].num, rows[0].title, rows[0].repo, rows[0].workerId, rows[1].group, rows[2].detail], ['1', 'Change 1', 'demo', 'W-1', 'b', 'test']);
});

test('mergeQueue: a PR that left can be put back once it can be merged again', () => {
  const q = leave(enqueue([], tasks, ['T-1'], NOW), 'T-1', 'ciFailed', NOW);
  assert.equal(queueRows(q, tasks)[0].again, true);
  assert.equal(queueRows(q, [task(1, { prChecks: { ...ok, ci: 'pending' } })])[0].again, false);
  // Its Worker is still fixing it.
  assert.equal(queueRows(q, [task(1), task(4, { prUrl: pr(1), status: 'running' })])[0].again, false);
});

test('mergeQueue: "Merge N" adds the ready PRs that are not in line yet', () => {
  const list = [task(1), task(2, { prChecks: { ...ok, ci: 'pending' } }), task(3)];
  assert.deepEqual(readyToQueue(list, []).map((x) => x.id), ['T-1', 'T-3']);
  const q = leave(enqueue([], list, ['T-1', 'T-3'], NOW), 'T-3', 'ciFailed', NOW);
  // One that left can be added again; one in line is not offered a second time.
  assert.deepEqual(readyToQueue(list, q).map((x) => x.id), ['T-3']);
});

test('mergeQueue: the PR is read again soon while GitHub is in the middle of something short', () => {
  assert.equal(tickAfter('updating', 'MERGEABLE'), MERGE_QUEUE.tickSoon);
  assert.equal(tickAfter('checks', 'UNKNOWN'), MERGE_QUEUE.tickSoon);
  assert.equal(tickAfter('checks', 'MERGEABLE'), MERGE_QUEUE.tick);
});

test('mergeQueue: every phase and every reason has its text in both languages', () => {
  assert.equal(tr('en', phaseKey('checks')), 'Waiting for checks');
  assert.equal(tr('ko', phaseKey('updating')), '브랜치 갱신 중');
  assert.equal(tr('en', 'mq.left', { why: tr('en', leftKey('ciFailed')) }), 'Left: checks failed');
  assert.equal(tr('ko', 'mq.left', { why: tr('ko', leftKey('bundle')) }), '빠짐: 묶음의 앞 PR이 빠짐');
});

test('mergeQueue: the Dispatcher is told which PR left and why', () => {
  assert.equal(leftNote(tasks[1], 'ciFailed', 'test'), `T-2 "Change 2" left the merge queue without being merged: its checks failed (test). ${pr(2)}`);
  assert.match(leftNote(tasks[0], 'bundle'), /an earlier PR of its bundle left the queue\. https/);
});

function inPhaseAt(q: MergeQueueEntry[], taskId: string, phase: MergeQueueEntry['phase']) {
  return q.map((e) => (e.taskId === taskId ? inPhase(e, phase, NOW) : e));
}
