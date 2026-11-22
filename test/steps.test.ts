// A task's planned steps (shared/steps.ts): declared and revised by its Worker, marked done, drawn in the sidebar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markDone, mergeProgress, reopenSteps, setSteps, stepSegments, stepsLine, stepView, MAX_STEPS } from '../src/shared/steps';
import type { Task } from '../src/shared/types';

const T = (over: Partial<Task> = {}) => ({ status: 'running', steps: null, ...over }) as Task;
const AT = '2026-11-22T10:00:00Z';

test('setSteps: trims, drops empty labels, cuts long ones and refuses too many', () => {
  const x = T();
  assert.equal(setSteps(x, ['  Plan ', '', 'Write\n tests', 'x'.repeat(80)]), null);
  assert.deepEqual(x.steps!.map((s) => s.title), ['Plan', 'Write tests', `${'x'.repeat(59)}…`]);
  assert.ok(x.steps!.every((s) => s.doneAt === null));
  assert.match(setSteps(x, []) ?? '', /at least one/);
  assert.match(setSteps(x, 'Plan') ?? '', /at least one/);
  assert.match(setSteps(x, Array.from({ length: MAX_STEPS + 1 }, (_, i) => `s${i}`)) ?? '', /at most 12/);
  // A refused plan leaves the old one as it was.
  assert.equal(x.steps!.length, 3);
});

test('setSteps: a revised plan keeps the steps already done that it still names', () => {
  const x = T();
  setSteps(x, ['Plan', 'Code', 'Test']);
  markDone(x, 1, AT);
  setSteps(x, ['plan', 'Code the parser', 'Test', 'Open PR']);
  assert.deepEqual(x.steps!.map((s) => s.doneAt), [AT, null, null, null]);
});

test('markDone: 1-based, idempotent, and out of range or without steps is an error', () => {
  const x = T();
  assert.match(markDone(x, 1, AT) ?? '', /set_steps first/);
  setSteps(x, ['a', 'b']);
  assert.equal(markDone(x, 2, AT), null);
  assert.equal(markDone(x, 2, '2026-11-22T11:00:00Z'), null);
  assert.equal(x.steps![1].doneAt, AT);
  for (const bad of [0, 3, 1.5, 'one', null]) assert.match(markDone(x, bad, AT) ?? '', /no step/, String(bad));
});

test('stepView, stepsLine and stepSegments: where the Worker is, also when it finished a step out of order', () => {
  assert.equal(stepView(T()), null);
  assert.equal(stepView(null), null);
  const x = T();
  setSteps(x, ['Plan', 'Code', 'Test']);
  markDone(x, 2, AT);
  assert.deepEqual(stepView(x), { done: 1, total: 3, at: 0, current: 'Plan', allDone: false });
  assert.deepEqual(stepSegments(x.steps!), ['cur', 'done', 'todo']);
  assert.equal(stepsLine(x.steps!), 'Step 1/3 now: Plan.');
  markDone(x, 1, AT); markDone(x, 3, AT);
  assert.deepEqual(stepView(x), { done: 3, total: 3, at: 3, current: 'Test', allDone: true });
  assert.deepEqual(stepSegments(x.steps!), ['done', 'done', 'done']);
  assert.equal(stepsLine(x.steps!), 'All 3 steps done.');
  // A long plan is one continuous bar.
  setSteps(x, Array.from({ length: 11 }, (_, i) => `s${i}`));
  assert.equal(stepSegments(x.steps!), null);
  assert.equal(stepSegments([]), null);
});

test('reopenSteps: a finished plan is cleared when its task goes back to work; a half-done one is kept', () => {
  const done = T({ status: 'pr_open' });
  setSteps(done, ['a', 'b']); markDone(done, 1, AT); markDone(done, 2, AT);
  reopenSteps(done, 'running');
  assert.equal(done.steps, null);

  const half = T({ status: 'failed' });
  setSteps(half, ['a', 'b']); markDone(half, 1, AT);
  reopenSteps(half, 'running');
  assert.equal(half.steps!.length, 2);

  // Running to waiting and back is the same round of work.
  const asking = T({ status: 'waiting' });
  setSteps(asking, ['a']); markDone(asking, 1, AT);
  reopenSteps(asking, 'running');
  assert.equal(asking.steps!.length, 1);
  // Finishing does not clear them: they stay with the task.
  reopenSteps(asking, 'pr_open');
  assert.equal(asking.steps!.length, 1);
});

test('mergeProgress: a newer progress line for the same task replaces the older one', () => {
  const u = ['W-1 (T-1) notes: hi', 'W-1 (T-1) progress: step 1/3 done'];
  mergeProgress(u, 'W-1 (T-1) progress:', 'W-1 (T-1) progress: step 2/3 done');
  mergeProgress(u, 'W-2 (T-2) progress:', 'W-2 (T-2) progress: step 1/2 done');
  assert.deepEqual(u, ['W-1 (T-1) notes: hi', 'W-1 (T-1) progress: step 2/3 done', 'W-2 (T-2) progress: step 1/2 done']);
});
