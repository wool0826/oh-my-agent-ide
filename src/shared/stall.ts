// A Worker whose task is open but whose session sits idle with nothing left to wake it (T-0046).
import type { Task, Worker } from './types';

/** How long an open task may sit with its Worker idle before the Worker is reminded, and then flagged as stalled. */
export const STALL_MS = 5 * 60_000;

/**
 * The task is running, but nothing runs it: no turn under way, no background subagents that will start one, and no
 * question, plan or answer it waits for (those tasks are 'waiting', or wait for a plan the user approves).
 */
export function isStalled(w: Worker, task: Task | null, session: { busy: boolean; background: number } | null, now = Date.now(), ms = STALL_MS) {
  if (!task || task.status !== 'running' || w.status !== 'idle') return false;
  if (session?.busy || (session?.background ?? 0) > 0) return false;
  if ((task.planFirst && !task.planApproved) || w.request || w.ask) return false;
  return now - Date.parse(w.lastActiveAt) >= ms;
}

/** What the window shows: flagged as stalled, and still idle on it. */
export const shownStalled = (w: Worker) => !!w.stalledAt && w.status === 'idle';
