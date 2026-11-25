import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KEEP_MARKS, ciRetries, filterPerms, firstMarks, lastWeek, outcome, percent, permCounts, permKind, permissionRows, retroTotals,
  spanTasks, stampHistory, taskRounds, taskTimes, totalMinutes, withPermission,
} from '../src/shared/retro';
import { ALLOW, ALLOW_TASK, DENY, GRANT_USED, type Task } from '../src/shared/types';

const task = (over: Partial<Task>): Task => ({
  id: 'T-1', title: 't', prompt: '', kind: 'code', repo: 'r', workerId: 'W-01', status: 'done', branch: null, prUrl: null, prState: null,
  summary: null, files: [], createdAt: '2026-11-22T10:00:00Z', updatedAt: '2026-11-22T10:00:00Z', finishedAt: null, reviewSyncedAt: null, seenCommentIds: [], ...over,
});
const at = (hm: string) => `2026-11-22T${hm}:00Z`;
const ms = (hm: string) => Date.parse(at(hm));

test('retro: a status change is marked once, and a wait for the Dispatcher apart from one for the user', () => {
  const x = task({ status: 'queued', history: firstMarks('queued', at('10:00')) });
  assert.equal(stampHistory([x], at('10:01')), false);
  x.status = 'running';
  assert.equal(stampHistory([x], at('10:05')), true);
  x.status = 'waiting'; x.waitingOn = 'dispatcher';
  stampHistory([x], at('10:20'));
  x.waitingOn = null;
  stampHistory([x], at('10:25'));
  assert.deepEqual(x.history, [
    { status: 'queued', at: at('10:00') }, { status: 'running', at: at('10:05') },
    { status: 'waiting', on: 'dispatcher', at: at('10:20') }, { status: 'waiting', at: at('10:25') },
  ]);
});

test('retro: tasks made before histories existed are not given one', () => {
  const x = task({ status: 'running' });
  assert.equal(stampHistory([x], at('10:00')), false);
  assert.equal(x.history, undefined);
});

test('retro: a history and the permission list keep only their latest marks', () => {
  const x = task({ status: 'running', history: Array.from({ length: KEEP_MARKS }, (_, i) => ({ status: i % 2 ? 'running' as const : 'waiting' as const, at: at('10:00') })) });
  x.status = 'waiting';
  stampHistory([x], at('11:00'));
  assert.equal(x.history!.length, KEEP_MARKS);
  assert.equal(x.history!.at(-1)!.at, at('11:00'));
  let list = withPermission(null, { at: at('10:00'), answeredAt: null, code: 'a', answer: ALLOW });
  for (let i = 0; i < KEEP_MARKS; i++) list = withPermission(list, { at: at('10:01'), answeredAt: null, code: 'b', answer: ALLOW });
  assert.equal(list.length, KEEP_MARKS);
  assert.equal(list[0].code, 'b');
});

test('retro: time is split by state from the history, later queue waits included', () => {
  const x = task({
    status: 'done',
    history: [
      { status: 'queued', at: at('10:00') }, { status: 'running', at: at('10:04') }, { status: 'waiting', at: at('10:30') },
      { status: 'running', at: at('10:36') }, { status: 'waiting', on: 'dispatcher', at: at('10:50') }, { status: 'running', at: at('10:52') },
      { status: 'pr_open', at: at('11:00') }, { status: 'queued', at: at('13:00') }, { status: 'running', at: at('13:03') }, { status: 'done', at: at('13:10') },
    ],
  });
  assert.deepEqual(taskTimes(x), { queue: 7, run: 26 + 14 + 8 + 7, you: 6, dispatcher: 2 });
});

test('retro: an open task counts up to now', () => {
  const x = task({ status: 'running', history: [{ status: 'queued', at: at('10:00') }, { status: 'running', at: at('10:10') }] });
  assert.deepEqual(taskTimes(x, ms('10:40')), { queue: 10, run: 30, you: 0, dispatcher: 0 });
});

test('retro: an older task without a history is read from its times, less its answered permissions', () => {
  const x = task({
    status: 'pr_open', createdAt: at('10:00'), startedAt: at('10:05'), finishedAt: at('11:05'),
    permissions: [{ at: at('10:20'), answeredAt: at('10:30'), code: 'git push', answer: ALLOW }, { at: at('10:40'), answeredAt: null, code: 'x', answer: GRANT_USED }],
  });
  const tm = taskTimes(x)!;
  assert.deepEqual(tm, { queue: 5, run: 50, you: 10, dispatcher: 0 });
  assert.equal(totalMinutes(tm), 65);
});

test('retro: a task that never started tells nothing unless it still waits to', () => {
  assert.equal(taskTimes(task({ status: 'cancelled' })), null);
  assert.deepEqual(taskTimes(task({ status: 'queued', createdAt: at('10:00') }), ms('10:12')), { queue: 12, run: 0, you: 0, dispatcher: 0 });
});

test('retro: a task sent back to work after it ended counts another round', () => {
  assert.equal(taskRounds(task({})), 1);
  assert.equal(taskRounds(task({ history: [{ status: 'running', at: at('10:00') }, { status: 'waiting', at: at('10:10') }, { status: 'running', at: at('10:12') }, { status: 'pr_open', at: at('10:30') }] })), 1);
  assert.equal(taskRounds(task({ history: [{ status: 'running', at: at('10:00') }, { status: 'pr_open', at: at('10:30') }, { status: 'running', at: at('12:00') }, { status: 'pr_open', at: at('12:10') }, { status: 'queued', at: at('13:00') }] })), 3);
});

test('retro: CI retries count every one, also past a "keep fixing"', () => {
  assert.equal(ciRetries({ ciFixAttempts: 1, ciFixTotal: 4 }), 4);
  assert.equal(ciRetries({ ciFixAttempts: 2 }), 2);
  assert.equal(ciRetries({}), 0);
});

test('retro: done and PR open succeed; Stop is not a failure', () => {
  assert.deepEqual(
    (['done', 'pr_open', 'failed', 'running', 'queued', 'cancelled'] as const).map((status) => outcome({ status })),
    ['success', 'success', 'failed', 'open', 'open', 'cancelled'],
  );
  assert.equal(outcome({ status: 'failed', stopped: true }), 'stopped');
});

test('retro: the week runs from local midnight six days ago to now', () => {
  const now = new Date(2026, 10, 26, 15, 30).getTime();
  const s = lastWeek(now);
  assert.equal(s.from, new Date(2026, 10, 20).getTime());
  assert.equal(s.to, now);
});

test('retro: a span holds tasks finished in it and open ones changed in it, newest first', () => {
  const s = { from: ms('09:00'), to: ms('18:00') };
  const list = spanTasks([
    task({ id: 'old', finishedAt: '2026-11-10T10:00:00Z' }),
    task({ id: 'a', finishedAt: at('11:00') }),
    task({ id: 'b', status: 'running', finishedAt: '2026-11-10T10:00:00Z', updatedAt: at('12:00') }),
    task({ id: 'gone', status: 'cancelled', updatedAt: at('12:00') }),
  ], s);
  assert.deepEqual(list.map((x) => x.id), ['b', 'a']);
});

test('retro: permission answers are told apart', () => {
  assert.deepEqual([ALLOW, ALLOW_TASK, GRANT_USED, DENY, 'only inside the worktree'].map(permKind), ['allow', 'task', 'rule', 'deny', 'note']);
});

test('retro: permission rows are newest first, with the wait and a denial note', () => {
  const rows = permissionRows([
    task({ id: 'T-1', permissions: [{ at: at('10:00'), answeredAt: at('10:03'), code: 'rm -rf dist', answer: ALLOW }] }),
    task({ id: 'T-2', permissions: [{ at: at('11:00'), answeredAt: at('11:07'), code: 'rm -rf ~', answer: 'Only delete inside the worktree' }, { at: at('08:00'), answeredAt: null, code: 'x', answer: GRANT_USED }] }),
  ], { from: ms('09:00'), to: ms('18:00') });
  assert.deepEqual(rows.map((r) => [r.taskId, r.kind, r.wait, r.note]), [['T-2', 'note', 7, 'Only delete inside the worktree'], ['T-1', 'allow', 3, null]]);
});

test('retro: the filter splits allowed from denied, and a rule use is no decision', () => {
  const rows = permissionRows([task({
    permissions: [ALLOW, ALLOW_TASK, GRANT_USED, DENY, 'no'].map((answer, i) => ({ at: at(`10:0${i}`), answeredAt: answer === GRANT_USED ? null : at(`10:0${i}`), code: answer, answer })),
  })]);
  assert.deepEqual(filterPerms(rows, 'allowed').map((r) => r.kind).sort(), ['allow', 'rule', 'task']);
  assert.deepEqual(filterPerms(rows, 'denied').map((r) => r.kind).sort(), ['deny', 'note']);
  assert.equal(filterPerms(rows, 'all').length, 5);
  assert.deepEqual(permCounts(rows), { allowed: 2, denied: 2 });
});

test('retro: totals count success over finished tasks, rounds, CI and spend', () => {
  const spend = (costUsd: number) => ({ costUsd, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const twice = [{ status: 'running' as const, at: at('10:00') }, { status: 'pr_open' as const, at: at('10:30') }, { status: 'running' as const, at: at('11:00') }, { status: 'pr_open' as const, at: at('11:20') }];
  const tot = retroTotals([
    task({ status: 'pr_open', history: twice, ciFixTotal: 2, spend: spend(1.5) }),
    task({ status: 'done', spend: spend(0.5) }),
    task({ status: 'failed' }),
    task({ status: 'failed', stopped: true }),
    task({ status: 'running', history: [{ status: 'running', at: at('10:00') }] }),
  ], [], ms('10:30'));
  assert.deepEqual([tot.tasks, tot.finished, tot.succeeded, tot.again, tot.ciRetries, tot.ciTasks, tot.spend?.costUsd], [5, 3, 2, 1, 2, 1, 2]);
  assert.equal(tot.run, 50 + 30);
  assert.equal(percent(tot.succeeded, tot.finished), 67);
  assert.equal(percent(0, 0), 0);
});
