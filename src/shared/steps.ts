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
  return v.allDone ? `All ${v.total} steps done.` : `Step ${v.at + 1}/${v.total} now: ${v.current}.`;
}

/** Pending updates for the Dispatcher with this progress line in place of an older one for the same task. */
export function mergeProgress(updates: string[], prefix: string, text: string) {
  const i = updates.findIndex((u) => u.startsWith(prefix));
  if (i >= 0) updates.splice(i, 1);
  updates.push(text);
  return updates;
}

export type Segment = 'done' | 'cur' | 'todo';

/**
 * The sidebar's bar: one segment per step (a step may be done out of order), or null for a long plan, which is
 * drawn as one continuous bar.
 */
export function stepSegments(steps: TaskStep[], max = 10): Segment[] | null {
  if (!steps.length || steps.length > max) return null;
  const at = steps.findIndex((s) => !s.doneAt);
  return steps.map((s, i) => (s.doneAt ? 'done' : i === at ? 'cur' : 'todo'));
}
