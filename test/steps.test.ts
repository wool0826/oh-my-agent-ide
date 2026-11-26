// A task's planned steps (shared/steps.ts): declared and revised by its Worker, marked done, drawn in the sidebar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markDone, mergeProgress, progressNote, reopenNote, reopenSteps, reworded, doneMask, setSteps, stepper, stepsLine, stepView, MAX_STEPS } from '../src/shared/steps';
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

test('setSteps: a reworded step at the same position stays done (T-0131 cause D)', () => {
  const x = T();
  setSteps(x, ['Read code', 'Write rule', 'Run checks', 'PR']);
  for (const n of [1, 2, 3]) markDone(x, n, AT);
  assert.equal(setSteps(x, ['Read code', 'Write the rule and its tests', 'Run checks (unit, e2e)', 'Self-review', 'PR']), null);
  assert.deepEqual(x.steps!.map((s) => !!s.doneAt), [true, true, true, false, false]);
  // A different step at that position, or a reworded one that moved, starts not done.
  setSteps(x, ['Read code', 'Open PR', 'Self-review', 'Write the rules']);
  assert.deepEqual(x.steps!.map((s) => !!s.doneAt), [true, false, false, false]);
});

test('reworded: the shorter title\'s words are all in the longer one, word stems included', () => {
  assert.equal(reworded('Run checks', 'Run checks (unit, e2e)'), true);
  assert.equal(reworded('Write the rules and tests', 'Write rule'), true);
  assert.equal(reworded('테스트 실행', '단위 테스트 실행'), true);
  assert.equal(reworded('Run checks', 'Open PR'), false);
  assert.equal(reworded('PR', 'Prepare docs'), false);
  assert.equal(reworded('—', 'Run'), false);
});

test('setSteps: a plan that keeps none of the done steps of an unfinished one is refused (T-0131 cause C)', () => {
  // T-0082: 4/5 done, stopped, then reopened by a message about other work.
  const x = T();
  setSteps(x, ['Read audit', 'Narrow window', 'Keyboard', 'Tests + build', 'Self-review, PR, merge']);
  for (const n of [1, 2, 3, 4]) markDone(x, n, AT);
  assert.match(setSteps(x, ['Inspect thread and branch features', 'Brief designer', 'Mockup artifact', 'Report']) ?? '', /^Not replaced: .*4\/5 steps done .*"Read audit".*Revise it instead/);
  assert.deepEqual(stepView(x), { done: 4, total: 5, at: 4, current: 'Self-review, PR, merge', allDone: false });
  // Revised with the done steps kept, the new work goes on from there.
  assert.equal(setSteps(x, ['Read audit', 'Narrow window', 'Keyboard', 'Tests + build', 'Mockup artifact', 'Report']), null);
  assert.equal(stepView(x)!.done, 4);
  // One done step kept is a revision: the plan is the Worker's to reshape.
  assert.equal(setSteps(x, ['Read audit', 'Report']), null);
  assert.equal(stepView(x)!.done, 1);
});

test('setSteps: a plan with no step done, or all done, may be replaced', () => {
  const x = T();
  setSteps(x, ['a', 'b']);
  assert.equal(setSteps(x, ['c', 'd']), null);
  markDone(x, 1, AT); markDone(x, 2, AT);
  assert.equal(setSteps(x, ['Fix review comments', 'Push']), null);
  assert.equal(stepView(x)!.done, 0);
});

test('progressNote: the count first and each step by its number, so a step done out of order reads right (T-0131)', () => {
  const x = T();
  setSteps(x, ['a', 'b', 'c', 'd', 'e', 'f']);
  for (const n of [1, 2, 4]) markDone(x, n, AT);
  assert.equal(progressNote(x.steps!, 4), '3/6 done (just finished step 4 "d"); next step 3 "c".');
  for (const n of [3, 5, 6]) markDone(x, n, AT);
  assert.equal(progressNote(x.steps!, 6), '6/6 done (just finished step 6 "f"); all steps done.');
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
  assert.equal(stepsLine(x.steps!), '1/3 done; now step 1: Plan.');
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

test('stepper: a long plan gets a three-line window that rolls up one line when a step is done', () => {
  const x = T();
  setSteps(x, ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
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
  // The line rolling out is still drawn, so it is not counted above yet.
  assert.equal(stepper(x.steps!, prev, Date.parse(AT) + 500).before, 0);
  assert.equal(stepper(x.steps!, null).before, 1);
  // Seen long after it was marked (the sidebar was collapsed): no motion.
  assert.deepEqual(view(prev, Date.parse(AT) + 60_000), { rolled: false, lines: ['b:done', 'c:cur', 'd:todo'] });
  // First time drawn: no motion either.
  assert.deepEqual(view(null), { rolled: false, lines: ['b:done', 'c:cur', 'd:todo'] });
  // At the end the window stops at the last three steps, also once all are done.
  for (const n of [3, 4, 5, 6]) markDone(x, n, AT);
  assert.deepEqual(view(null).lines, ['e:done', 'f:done', 'g:cur']);
  prev = doneMask(x.steps!);
  markDone(x, 7, AT);
  assert.deepEqual(view(prev), { rolled: false, lines: ['e:done', 'f:done', 'g:done!'] });
  // Three steps done at once move the window by two lines: no roll, the last one done still pops.
  for (const st of x.steps!) st.doneAt = null;
  prev = doneMask(x.steps!);
  markDone(x, 1, AT); markDone(x, 2, AT); markDone(x, 3, AT);
  assert.deepEqual(view(prev), { rolled: false, lines: ['c:done!', 'd:cur', 'e:todo'] });
  // A doneAt that does not parse plays nothing.
  prev = doneMask(x.steps!);
  x.steps![3].doneAt = 'not a time';
  assert.deepEqual(view(prev).lines, ['d:done', 'e:cur', 'f:todo']);
  // A plan of one step shows one line; a new plan of another length plays nothing.
  x.steps = null;
  setSteps(x, ['only']);
  assert.deepEqual(view('00000'), { rolled: false, lines: ['only:cur'] });
  assert.equal(stepper(x.steps!, null).size, 1);
});

test('stepper: steps done out of order stay in plan order, the count is of done steps, a short plan is drawn whole (T-0044)', () => {
  // The bug report: five steps, 1, 2 and 4 done. The row said "3/5" over a three-line window that hid steps 1 and 5.
  const x = T();
  setSteps(x, ['Survey', 'Render', 'Report', 'Artifact', 'Verify']);
  for (const n of [1, 2, 4]) markDone(x, n, AT);
  assert.deepEqual(stepView(x), { done: 3, total: 5, at: 2, current: 'Report', allDone: false });
  const v = stepper(x.steps!, null);
  assert.deepEqual(v.lines.map((l) => `${l.i + 1}.${l.title}:${l.seg}`), ['1.Survey:done', '2.Render:done', '3.Report:cur', '4.Artifact:done', '5.Verify:todo']);
  assert.deepEqual([v.size, v.before, v.after, v.afterDone], [5, 0, 0, 0]);
  assert.equal(stepsLine(x.steps!), '3/5 done; now step 3: Report.');
  // Drawn whole, a step done since the last draw pops in place and nothing rolls.
  const prev = doneMask(x.steps!);
  markDone(x, 3, AT);
  const w = stepper(x.steps!, prev, Date.parse(AT) + 500);
  assert.deepEqual([w.rolled, w.before, w.after, w.lines.length, w.lines[2].just], [false, 0, 0, 5, true]);
  // Six steps, just over the whole-plan size: a window, with a later step done out of order counted below.
  x.steps = null;
  setSteps(x, ['a', 'b', 'c', 'd', 'e', 'f']);
  markDone(x, 6, AT);
  const six = stepper(x.steps!, null);
  assert.deepEqual([six.size, six.before, six.after, six.afterDone], [3, 0, 3, 1]);
});

test('stepper: the window on a long plan keeps the current step in view and counts the steps it hides', () => {
  const x = T();
  setSteps(x, ['1', '2', '3', '4', '5', '6', '7', '8']);
  const shape = () => { const v = stepper(x.steps!, null); return [v.lines.map((l) => `${l.title}:${l.seg}`).join(' '), v.before, v.after, v.afterDone]; };
  assert.deepEqual(shape(), ['1:cur 2:todo 3:todo', 0, 5, 0]);
  // Steps 1 to 3 and 6 done: the window is on 4, the step before it and the next; 6 is done among the hidden ones.
  for (const n of [1, 2, 3, 6]) markDone(x, n, AT);
  assert.deepEqual(shape(), ['3:done 4:cur 5:todo', 2, 3, 1]);
  // Out of order the other way: the current step is still the first one not done, whatever was marked last.
  for (const n of [7, 8]) markDone(x, n, AT);
  assert.deepEqual(shape(), ['3:done 4:cur 5:todo', 2, 3, 3]);
  markDone(x, 4, AT); markDone(x, 5, AT);
  assert.deepEqual(shape(), ['6:done 7:done 8:done', 5, 0, 0]);
});

test('reopenNote: whether a reopened task kept its plan, and how far it was', () => {
  const t = T({ status: 'failed' });
  assert.equal(reopenNote(stepView(t), stepView(t)), 'no plan');
  setSteps(t, ['a', 'b', 'c']); markDone(t, 1, AT);
  assert.equal(reopenNote(stepView(t), stepView(t)), 'plan kept at 1/3');
  assert.equal(reopenNote(stepView(t), null), 'plan cleared at 1/3');
});
