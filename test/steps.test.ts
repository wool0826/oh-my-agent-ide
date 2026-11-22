// A task's planned steps (shared/steps.ts): declared and revised by its Worker, marked done, drawn in the sidebar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markDone, mergeProgress, reopenSteps, doneMask, setSteps, stepper, stepsLine, stepView, MAX_STEPS } from '../src/shared/steps';
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
  // A repeated title takes the done step once.
  setSteps(x, ['Plan', 'Plan']);
  assert.deepEqual(x.steps!.map((s) => s.doneAt), [AT, null]);
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

test('stepView and stepsLine: where the Worker is, also when it finished a step out of order', () => {
  assert.equal(stepView(T()), null);
  assert.equal(stepView(null), null);
  const x = T();
  setSteps(x, ['Plan', 'Code', 'Test']);
  markDone(x, 2, AT);
  assert.deepEqual(stepView(x), { done: 1, total: 3, at: 0, current: 'Plan', allDone: false });
  assert.deepEqual(stepper(x.steps!, null).lines.map((l) => l.seg), ['cur', 'done', 'todo']);
  assert.equal(stepsLine(x.steps!), 'Step 1/3 now: Plan.');
  markDone(x, 1, AT); markDone(x, 3, AT);
  assert.deepEqual(stepView(x), { done: 3, total: 3, at: 3, current: 'Test', allDone: true });
  assert.equal(stepsLine(x.steps!), 'All 3 steps done.');
});

test('reopenSteps: a finished task going back to work starts without steps; a plan cut short is kept', () => {
  const done = T({ status: 'pr_open' });
  setSteps(done, ['a', 'b']); markDone(done, 1, AT); markDone(done, 2, AT);
  reopenSteps(done, 'running');
  assert.equal(done.steps, null);
  // Finished with a step left unmarked: still a new round.
  const left = T({ status: 'done' });
  setSteps(left, ['a', 'b']); markDone(left, 1, AT);
  reopenSteps(left, 'running');
  assert.equal(left.steps, null);

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

test('stepper: a three-line window on the plan that rolls up one line when a step is done', () => {
  const x = T();
  setSteps(x, ['a', 'b', 'c', 'd', 'e']);
  const view = (prev: string | null, now = Date.parse(AT) + 500) => {
    const v = stepper(x.steps!, prev, now);
    return { rolled: v.rolled, lines: v.lines.map((l) => `${l.title}:${l.seg}${l.just ? '!' : ''}`) };
  };
  // Nothing done yet: the current step first, then the next two.
  assert.deepEqual(view(null), { rolled: false, lines: ['a:cur', 'b:todo', 'c:todo'] });
  // Step 1 done: the window stays, step 1 ticks.
  let prev = doneMask(x.steps!);
  markDone(x, 1, AT);
  assert.deepEqual(view(prev), { rolled: false, lines: ['a:done!', 'b:cur', 'c:todo'] });
  // The same state drawn again plays nothing.
  assert.deepEqual(view(doneMask(x.steps!)), { rolled: false, lines: ['a:done', 'b:cur', 'c:todo'] });
  // Step 2 done: the window moves on one line; the line leaving is drawn too, for the roll.
  prev = doneMask(x.steps!);
  markDone(x, 2, AT);
  assert.deepEqual(view(prev), { rolled: true, lines: ['a:done', 'b:done!', 'c:cur', 'd:todo'] });
  // Seen long after it was marked (the sidebar was collapsed): no motion.
  assert.deepEqual(view(prev, Date.parse(AT) + 60_000), { rolled: false, lines: ['b:done', 'c:cur', 'd:todo'] });
  // First time drawn: no motion either.
  assert.deepEqual(view(null), { rolled: false, lines: ['b:done', 'c:cur', 'd:todo'] });
  // At the end the window stops at the last three steps, also once all are done.
  markDone(x, 3, AT); markDone(x, 4, AT);
  assert.deepEqual(view(null).lines, ['c:done', 'd:done', 'e:cur']);
  prev = doneMask(x.steps!);
  markDone(x, 5, AT);
  assert.deepEqual(view(prev), { rolled: false, lines: ['c:done', 'd:done', 'e:done!'] });
  // A plan of one or two steps shows that many lines; a new plan of another length plays nothing.
  setSteps(x, ['only']);
  assert.deepEqual(view('00000'), { rolled: false, lines: ['only:cur'] });
  assert.equal(stepper(x.steps!, null).size, 1);
});
