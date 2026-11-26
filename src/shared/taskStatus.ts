// How a Worker's task moves between statuses, and when a follow-up message reopens a finished one.

import { reopenSteps } from './steps';
import type { Task, TaskStatus } from './types';

/** How long after a task finished (or failed) a follow-up reopens it instead of being a message on its own. */
export const REOPEN_MS = 3 * 86400_000;

/**
 * Set a task's status. Starting or ending a wait forgets the last one's timer and released slot, so two short waits
 * never add up to the time after which a waiting task gives its slot back. The new timer starts here, so the card's
 * slot clock shows from the start instead of after the next sweep (sweepWaiting starts one a task lacks).
 */
export function setStatus(task: Task, status: TaskStatus, on: Task['waitingOn'] = null, now = new Date().toISOString()) {
  reopenSteps(task, status);
  if ((status === 'waiting') !== (task.status === 'waiting')) {
    task.waitingSince = status === 'waiting' ? now : null;
    task.slotReleased = false;
  }
  task.status = status;
  task.waitingOn = status === 'waiting' ? on : null;
}

/**
 * A Worker's last task that a follow-up would reopen: done, in review or failed less than 3 days ago, with its PR
 * neither merged nor closed. A failed task never got finishedAt; it failed when it was last updated.
 */
export function canReopen(last: Pick<Task, 'status' | 'finishedAt' | 'updatedAt' | 'prState'> | null | undefined, now = Date.now()): boolean {
  if (!last || (last.status !== 'done' && last.status !== 'pr_open' && last.status !== 'failed')) return false;
  const at = last.finishedAt ?? (last.status === 'failed' ? last.updatedAt : null);
  if (!at || now - Date.parse(at) > REOPEN_MS) return false;
  return last.prState !== 'MERGED' && last.prState !== 'CLOSED';
}
