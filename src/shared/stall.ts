// A Worker whose task is open but whose session sits idle with nothing left to wake it (T-0046).
import type { Task, Worker } from './types';

/** How long an open task may sit with its Worker idle before the Worker is reminded, and then flagged as stalled. */
export const STALL_MS = 5 * 60_000;
/**
 * How long a Worker may wait on background shells alone (a test run, a build) before the same reminder. Long, since
 * such a run often takes many minutes; but a shell may also be a server that never ends, so the wait is not endless.
 */
export const SHELL_STALL_MS = 30 * 60_000;

/**
 * The task is running, but nothing runs it: no turn under way, no background subagents that will start one, and no
 * question, plan or answer it waits for (those tasks are 'waiting', or wait for a plan the user approves). Background
 * shells will start a turn too, but only for SHELL_STALL_MS.
 * A Worker waiting on background work shows as running, so `idle` is not required when any is left.
 */
export function isStalled(w: Worker, task: Task | null, session: { busy: boolean; background: number; shells?: number } | null, now = Date.now(), ms = STALL_MS) {
  if (!task || task.status !== 'running') return false;
  if (session?.busy || (session?.background ?? 0) > 0) return false;
  const shells = (session?.shells ?? 0) > 0;
  if (w.status !== 'idle' && !(shells && w.status === 'running')) return false;
  if ((task.planFirst && !task.planApproved) || w.request || w.ask) return false;
  return now - Date.parse(w.lastActiveAt) >= (shells && ms > 0 ? Math.max(ms, SHELL_STALL_MS) : ms);
}

/** What the window shows: flagged as stalled, and still idle on it. */
export const shownStalled = (w: Pick<Worker, 'stalledAt' | 'status'>) => !!w.stalledAt && w.status === 'idle';
