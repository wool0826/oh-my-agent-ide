// Which of a Worker's tasks it is on now. Main writes set_steps, step_done and the result to it, and every screen
// draws that Worker with it, so both sides pick it with this one rule. A follow-up chained after the running task
// (after_task_id, same Worker) is last in taskIds but has not started; it must not hide the running task or its steps.

import type { Task, TaskStatus, Worker } from './types';

type Find<T> = (id: string) => T | null | undefined;
type W = Pick<Worker, 'taskIds'>;

const OPEN: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['running', 'waiting', 'queued']);

/** The Worker is on it (running, or waiting for an answer), or it waits for a slot or a usage limit to go on. Blocked has not started. */
export const isOpen = (x: Pick<Task, 'status'>) => OPEN.has(x.status);

/** The last task in taskIds, open or not. */
export function lastTask<T>(w: W, find: Find<T>): T | null {
  return w.taskIds.length ? find(w.taskIds[w.taskIds.length - 1]) ?? null : null;
}

/** The Worker's open task: the last open one in taskIds, or null. Its steps and result go there. */
export function openTask<T extends Pick<Task, 'status'>>(w: W, find: Find<T>): T | null {
  for (let i = w.taskIds.length - 1; i >= 0; i--) {
    const x = find(w.taskIds[i]);
    if (x && isOpen(x)) return x;
  }
  return null;
}

/** The task a Worker is shown with: its open task, otherwise its latest. */
export function currentTask<T extends Pick<Task, 'status'>>(w: W, find: Find<T>): T | null {
  return openTask(w, find) ?? lastTask(w, find);
}

/**
 * The open task that keeps a Worker from taking a new task now, or null. A second open task later in taskIds would
 * take over the first one's steps and result while the Worker is still on it. A new task may wait for it instead:
 * `after` (its after_task_id) is the open task, or a task already chained after it.
 */
export function busyWith<T extends Pick<Task, 'id' | 'status' | 'afterTaskId'>>(w: W, find: Find<T>, after: string | null): T | null {
  const cur = openTask(w, find);
  if (!cur) return null;
  const seen = new Set<string>();
  for (let id = after; id && !seen.has(id); id = find(id)?.afterTaskId ?? null) {
    if (id === cur.id) return null;
    seen.add(id);
  }
  return cur;
}

/**
 * The window drew a Worker with an open task other than main's (`mainId`, its open task in the same state): their
 * copies of the state disagree. The two ids, or null when they agree.
 */
export function drawnMismatch<T extends Pick<Task, 'id' | 'status'>>(w: W, find: Find<T>, mainId: string | null): { drawn: string | null; main: string | null } | null {
  const drawn = openTask(w, find)?.id ?? null;
  return drawn === mainId ? null : { drawn, main: mainId };
}

/** Each Worker's open task id, for the Workers that have one: what main sends the window to compare (drawnMismatch). */
export function openTaskIds<T extends Pick<Task, 'id' | 'status'>>(workers: readonly (W & Pick<Worker, 'id'>)[], find: Find<T>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const w of workers) {
    const x = openTask(w, find);
    if (x) out[w.id] = x.id;
  }
  return out;
}
