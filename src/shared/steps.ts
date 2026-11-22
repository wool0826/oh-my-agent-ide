// A task's planned steps: a Worker declares them (set_steps) and marks each one done (step_done); the sidebar draws
// them under the Worker's row and the Dispatcher reads them in list_workers. Kept here so they can be tested.
import type { Task, TaskStep } from './types';

export const MAX_STEPS = 12;
export const STEP_LEN = 60;

export interface StepView {
  done: number;
  total: number;
  /** 0-based index of the first step not done yet; equals total when all are done. */
  at: number;
  /** The step being worked on, or the last one when all are done. */
  current: string;
  allDone: boolean;
}

const key = (s: string) => s.trim().toLowerCase();

/** Declare or revise the plan. Steps already done keep their time when the new plan still names them. Returns an error text, or null. */
export function setSteps(task: Task, titles: unknown): string | null {
  const list = (Array.isArray(titles) ? titles : [])
    .map((x) => (typeof x === 'string' ? x.replace(/\s+/g, ' ').trim() : ''))
    .filter(Boolean)
    .map((x) => (x.length > STEP_LEN ? `${x.slice(0, STEP_LEN - 1)}…` : x));
  if (!list.length) return 'Give at least one step.';
  if (list.length > MAX_STEPS) return `Give at most ${MAX_STEPS} steps; merge the small ones.`;
  // Each step done before counts once, so a title the new plan repeats is not done twice.
  const doneBefore = (task.steps ?? []).filter((s) => s.doneAt);
  task.steps = list.map((title) => {
    const i = doneBefore.findIndex((s) => key(s.title) === key(title));
    return { title, doneAt: i < 0 ? null : doneBefore.splice(i, 1)[0].doneAt };
  });
  return null;
}

/** Mark step n (1-based) done; marking it again changes nothing. Returns an error text, or null. */
export function markDone(task: Task, n: unknown, now: string): string | null {
  const steps = task.steps ?? [];
  if (!steps.length) return 'No steps yet: declare them with set_steps first.';
  const i = typeof n === 'number' ? n : Number(n);
  if (!Number.isInteger(i) || i < 1 || i > steps.length) return `There is no step ${String(n)}; the steps are 1 to ${steps.length}.`;
  if (!steps[i - 1].doneAt) steps[i - 1].doneAt = now;
  return null;
}

export function stepView(task: Pick<Task, 'steps'> | null | undefined): StepView | null {
  const steps = task?.steps ?? [];
  if (!steps.length) return null;
  const done = steps.filter((s) => s.doneAt).length;
  const open = steps.findIndex((s) => !s.doneAt);
  const at = open < 0 ? steps.length : open;
  return { done, total: steps.length, at, current: steps[Math.min(at, steps.length - 1)].title, allDone: open < 0 };
}

/**
 * A finished task that goes back to work (review comments, a CI fix, a follow-up) starts a new round without steps,
 * even when its Worker left some unmarked. A plan cut short (stopped or failed, then resumed) is kept, so it goes on
 * where it was.
 */
export function reopenSteps(task: Task, to: Task['status']) {
  if (to === 'running' && (task.status === 'pr_open' || task.status === 'done')) task.steps = null;
}

/** The tool's reply and the Dispatcher's line after a change. */
export function stepsLine(steps: TaskStep[]) {
  const v = stepView({ steps })!;
  return v.allDone ? `All ${v.total} steps done.` : `${v.done}/${v.total} done; now step ${v.at + 1}: ${v.current}.`;
}

/** Pending updates for the Dispatcher with this progress line in place of an older one for the same task. */
export function mergeProgress(updates: string[], prefix: string, text: string) {
  const i = updates.findIndex((u) => u.startsWith(prefix));
  if (i >= 0) updates.splice(i, 1);
  updates.push(text);
  return updates;
}

export type Segment = 'done' | 'cur' | 'todo';

/** Which steps are done, one character each ("1" done, "0" not): what the sidebar remembers between renders. */
export function doneMask(steps: TaskStep[]) {
  return steps.map((s) => (s.doneAt ? '1' : '0')).join('');
}

export interface StepperLine { i: number; title: string; seg: Segment; just: boolean }

/** How long after a step is marked done the sidebar still plays "just done" on it. */
export const JUST_MS = 3000;

/** Plans this long or shorter are drawn whole; a longer one gets a three-line window with the hidden steps counted. */
export const STEPPER_ALL = 5;

/**
 * The sidebar's Stepper. Lines are always in plan order, each drawn from its own done state, so a step marked out of
 * order shows as done where it is; the current step is the first one not done. A plan of up to STEPPER_ALL steps is
 * drawn whole. A longer one gets a window of three lines (the step before the current one, the current one and the
 * next), and `before` / `after` count the steps it hides on each side, with `afterDone` of the later ones done.
 * `prev` is the doneMask the sidebar drew last time for the same plan; a step done since then (and not long ago) is
 * `just`, and when that moves the window on by one line, the line that leaves is drawn too and `rolled` is set, so the
 * list can roll up into place.
 */
export function stepper(steps: TaskStep[], prev: string | null, now = Date.now()) {
  const n = steps.length;
  const size = n <= STEPPER_ALL ? n : 3;
  const first = (mask: string) => { const i = mask.indexOf('0'); return i < 0 ? n : i; };
  const startAt = (at: number) => Math.max(0, Math.min(at - 1, n - size));
  const mask = doneMask(steps);
  const at = first(mask);
  const start = startAt(at);
  const known = prev !== null && prev.length === n;
  const just = (i: number) => known && prev![i] === '0' && mask[i] === '1' && now - Date.parse(steps[i].doneAt!) < JUST_MS;
  const rolled = known && steps.some((_, i) => just(i)) && startAt(first(prev!)) === start - 1;
  const lines: StepperLine[] = [];
  for (let i = rolled ? start - 1 : start; i < start + size; i++) {
    lines.push({ i, title: steps[i].title, seg: steps[i].doneAt ? 'done' : i === at ? 'cur' : 'todo', just: just(i) });
  }
  const later = steps.slice(start + size);
  // While the leaving line rolls out it is still drawn, so it is not counted above yet.
  return { size, rolled, lines, before: rolled ? start - 1 : start, after: later.length, afterDone: later.filter((s) => s.doneAt).length };
}
