import { test } from 'node:test';
import assert from 'node:assert/strict';
import { busyWith, currentTask, drawnMismatch, lastTask, openTask, openTaskIds } from '../src/shared/currentTask';
import { canStart } from '../src/shared/slots';
import { markDone, setSteps, stepView } from '../src/shared/steps';
import type { Task } from '../src/shared/types';

const NOW = '2026-11-26T10:00:00.000Z';

function task(id: string, status: Task['status'], patch: Partial<Task> = {}): Task {
  return {
    id, title: id, prompt: '', kind: 'code', repo: 'app', workerId: 'W-01', status, branch: null, prUrl: null, prState: null,
    summary: null, files: [], createdAt: NOW, updatedAt: NOW, startedAt: NOW, finishedAt: null, reviewSyncedAt: null, seenCommentIds: [], afterTaskId: null, ...patch,
  };
}
const finder = (tasks: Task[]) => (id: string) => tasks.find((x) => x.id === id);

test('currentTask: the last open task, otherwise the last task, otherwise none', () => {
  const tasks = [task('T-1', 'done'), task('T-2', 'pr_open'), task('T-3', 'failed')];
  const find = finder(tasks);
  assert.equal(currentTask({ taskIds: [] }, find), null);
  assert.equal(currentTask({ taskIds: ['T-1', 'T-2', 'T-3'] }, find)?.id, 'T-3');
  assert.equal(openTask({ taskIds: ['T-1', 'T-2', 'T-3'] }, find), null);
  for (const st of ['running', 'waiting', 'queued'] as const) {
    tasks[0].status = st;
    assert.equal(currentTask({ taskIds: ['T-1', 'T-2', 'T-3'] }, find)?.id, 'T-1', st);
  }
  assert.equal(lastTask({ taskIds: ['T-1', 'T-2', 'T-3'] }, find)?.id, 'T-3');
  // A task the window no longer has is skipped, not drawn as nothing.
  assert.equal(currentTask({ taskIds: ['T-1', 'T-9'] }, find)?.id, 'T-1');
});

test('currentTask: a follow-up chained after the running task (after_task_id) does not hide it or its steps', () => {
  // W-08 on 2026-11-26: T-0117 ran while T-0118 and T-0119 waited after it on the same Worker (T-0131 cause A).
  const a = task('T-0117', 'running');
  setSteps(a, ['Plan', 'Generate', 'Verify']);
  markDone(a, 1, NOW);
  const tasks = [a, task('T-0118', 'blocked', { afterTaskId: 'T-0117' }), task('T-0119', 'blocked', { afterTaskId: 'T-0118' })];
  const w = { taskIds: ['T-0117', 'T-0118', 'T-0119'] };
  assert.equal(openTask(w, finder(tasks))?.id, 'T-0117', 'main writes the steps to T-0117');
  assert.equal(currentTask(w, finder(tasks))?.id, 'T-0117', 'and the window draws T-0117');
  assert.equal(stepView(currentTask(w, finder(tasks)))?.done, 1);
  // Once it ends with its PR open, the next one waiting is what the Worker shows.
  a.status = 'pr_open';
  assert.equal(currentTask(w, finder(tasks))?.id, 'T-0119');
});

test('busyWith: a Worker on an open task takes a new one only chained after it (T-0131 cause B)', () => {
  // canStart is true for a Worker that already holds a slot, so a slot check alone would start the new task at once.
  const tasks = [task('T-A', 'running')];
  assert.equal(canStart(tasks, 'W-01', 1), true);
  const w = { taskIds: ['T-A'] };
  assert.equal(busyWith(w, finder(tasks), null)?.id, 'T-A');
  assert.equal(busyWith(w, finder(tasks), 'T-A'), null);
  // Chained after a task that is itself chained after the open one.
  tasks.push(task('T-B', 'blocked', { afterTaskId: 'T-A' }));
  assert.equal(busyWith({ taskIds: ['T-A', 'T-B'] }, finder(tasks), 'T-B'), null);
  // After another Worker's task, it could start while this Worker is still on T-A.
  tasks.push(task('T-X', 'running', { workerId: 'W-02' }));
  assert.equal(busyWith(w, finder(tasks), 'T-X')?.id, 'T-A');
  // Waiting for an answer or for a slot is still open.
  for (const st of ['waiting', 'queued'] as const) {
    tasks[0].status = st;
    assert.equal(busyWith(w, finder(tasks), null)?.id, 'T-A', st);
  }
  for (const st of ['pr_open', 'done', 'failed', 'blocked'] as const) {
    tasks[0].status = st;
    assert.equal(busyWith(w, finder(tasks), null), null, st);
  }
});

test('busyWith: a loop of after_task_id ends', () => {
  const tasks = [task('T-A', 'running'), task('T-B', 'blocked', { afterTaskId: 'T-C' }), task('T-C', 'blocked', { afterTaskId: 'T-B' })];
  assert.equal(busyWith({ taskIds: ['T-A'] }, finder(tasks), 'T-B')?.id, 'T-A');
});

test('drawnMismatch and openTaskIds: the window and main agree on each Worker\'s open task, or the ids it differs by', () => {
  const tasks = [task('T-1', 'running'), task('T-2', 'blocked', { afterTaskId: 'T-1' }), task('T-3', 'done', { workerId: 'W-02' })];
  const workers = [{ id: 'W-01', taskIds: ['T-1', 'T-2'] }, { id: 'W-02', taskIds: ['T-3'] }];
  const ids: Record<string, string> = openTaskIds(workers, finder(tasks));
  assert.equal(drawnMismatch(workers[0], finder(tasks), ids['W-01']), null);
  assert.equal(drawnMismatch(workers[1], finder(tasks), ids['W-02'] ?? null), null);
  assert.deepEqual(ids, { 'W-01': 'T-1' });
  // The window's copy still has T-1 running after main finished it.
  assert.deepEqual(drawnMismatch(workers[0], finder(tasks), null), { drawn: 'T-1', main: null });
  assert.deepEqual(drawnMismatch(workers[1], finder(tasks), 'T-4'), { drawn: null, main: 'T-4' });
});
