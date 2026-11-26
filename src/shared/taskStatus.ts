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

/** A task whose status changed since it was last seen: what the app log says about it. */
export interface StatusMove { id: string; from: TaskStatus; to: TaskStatus; pr: boolean }

/**
 * The tasks whose status changed since `seen` was last brought up to date, which this does. A task seen for the
 * first time is not a move.
 */
export function statusMoves(seen: Map<string, TaskStatus>, tasks: readonly Pick<Task, 'id' | 'status' | 'prUrl'>[]): StatusMove[] {
  const out: StatusMove[] = [];
  for (const x of tasks) {
    const from = seen.get(x.id);
    if (from && from !== x.status) out.push({ id: x.id, from, to: x.status, pr: !!x.prUrl });
    seen.set(x.id, x.status);
  }
  return out;
}

/** The app log's line for a move, e.g. `task T-1 running -> done (PR: no) via finish < onResult`. */
export function moveLine(x: StatusMove, via: string): string {
  return `task ${x.id} ${x.from} -> ${x.to} (PR: ${x.pr ? 'yes' : 'no'}) via ${via}`;
}

/**
 * The functions on a stack below `fn`, nearest first and at most `n`: which code changed a task, for the app log.
 * Anonymous frames, Array methods and the methods of `fn`'s own class (the store calling itself) are left out.
 */
export function callers(stack: string, fn: string, n = 3): string {
  const names = stack.split('\n').map((l) => /^\s*at (?:async )?(?:new )?([^\s(]+) \(/.exec(l)?.[1] ?? null);
  const from = names.findIndex((x) => x?.split('.').pop() === fn);
  const self = from >= 0 ? names[from] ?? '' : '';
  const own = self.includes('.') ? self.slice(0, self.lastIndexOf('.') + 1) : null;
  const out = names.slice(from + 1).filter((x): x is string => !!x && !(own && x.startsWith(own)) && !/^Array\.|^<anonymous>$/.test(x));
  return out.slice(0, n).join(' < ') || 'unknown';
}
