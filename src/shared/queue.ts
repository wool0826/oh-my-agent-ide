// Which tasks the user can cancel from the queue, and what cancelling one does.
// Shared by the main process (which cancels) and the renderer (which asks first).

import type { Task, TaskStatus } from './types';

/** Waiting to start: paused by a usage limit (queued) or waiting for another task's PR to merge (blocked). */
export function isQueued(t: Pick<Task, 'status'>): boolean {
  return t.status === 'queued' || t.status === 'blocked';
}

/**
 * Keep the time each task entered the queue (L13). Called on every state change: a task seen queued for the first
 * time takes its updatedAt, which every queueing sets; one that left the queue loses it. Says whether anything changed.
 */
export function stampQueued(tasks: Pick<Task, 'status' | 'updatedAt' | 'queuedSince'>[]): boolean {
  let changed = false;
  for (const t of tasks) {
    const q = isQueued(t);
    if (q && !t.queuedSince) { t.queuedSince = t.updatedAt; changed = true; }
    else if (!q && t.queuedSince) { t.queuedSince = null; changed = true; }
  }
  return changed;
}

/** The task still has an open PR, which cancelling never touches. */
export function hasOpenPr(t: Pick<Task, 'prUrl' | 'prState'>): boolean {
  return !!t.prUrl && t.prState !== 'MERGED' && t.prState !== 'CLOSED';
}

/**
 * The status a queued task takes when it is cancelled.
 * A task that already finished once was queued again for review fixes or a follow-up:
 * only that queued work is dropped and the task keeps its result (PR in review, or done).
 * Anything else is cancelled.
 */
export function statusAfterCancel(t: Pick<Task, 'prUrl' | 'prState' | 'finishedAt'>): TaskStatus {
  if (hasOpenPr(t)) return 'pr_open';
  if (t.finishedAt) return 'done';
  return 'cancelled';
}

/**
 * Tasks waiting (after_task_id) on this task, directly or through another waiting task.
 * They can never start once it is cancelled, so they are cancelled with it,
 * unless it keeps an open PR they can still wait for.
 */
export function followersOf(tasks: Task[], id: string): Task[] {
  const out: Task[] = [];
  const seen = new Set([id]);
  const walk = (dep: string) => {
    for (const t of tasks) {
      if (t.status !== 'blocked' || t.afterTaskId !== dep || seen.has(t.id)) continue;
      seen.add(t.id);
      out.push(t);
      walk(t.id);
    }
  };
  walk(id);
  return out;
}

/**
 * What a task blocked on `dep` (after_task_id) does now.
 * wait: dep is still in progress, or has an open PR to merge (a failed review fix leaves the PR open too).
 * start: dep's PR was merged, or dep finished without a PR, so there is nothing more to wait for.
 * cancel: dep failed, was cancelled, its PR was closed without merging, or it is gone: what the task builds on never comes.
 */
export function afterDependency(dep: Pick<Task, 'status' | 'prUrl' | 'prState'> | null | undefined): 'wait' | 'start' | 'cancel' {
  if (!dep) return 'cancel';
  if (dep.prState === 'MERGED') return 'start';
  if (dep.prState === 'CLOSED') return 'cancel';
  if (hasOpenPr(dep)) return 'wait';
  if (dep.status === 'done') return 'start';
  if (dep.status === 'failed' || dep.status === 'cancelled') return 'cancel';
  return 'wait';
}

/** A task that still needs its Worker's worktree: its PR may get review fixes, or it has yet to start there. */
export function holdsWorktree(x: Pick<Task, 'status'> | null | undefined): boolean {
  return x?.status === 'pr_open' || x?.status === 'blocked' || x?.status === 'queued';
}

/** What cancelling one task did. */
export interface CancelReport {
  id: string;
  title: string;
  workerId: string | null;
  /** The status it took: cancelled, or pr_open/done when only queued review, CI or follow-up work was dropped. */
  status: TaskStatus;
  /** Cancelled because it waited (after_task_id) for this task. */
  followerOf: string | null;
  /** Its branch was kept because deleting it would lose work. */
  kept: { branch: string; commits: number; dirty: boolean; path: string } | null;
}

/** One line for the Dispatcher (English, like every agent-facing text). */
export function describeCancel(r: CancelReport): string {
  const what = r.status === 'cancelled'
    ? `cancelled${r.followerOf ? ` (it waited for ${r.followerOf})` : ''}`
    : `queued work dropped; the task stays ${r.status}${r.status === 'pr_open' ? ' and its PR stays open' : ''}`;
  const kept = r.kept
    ? `; branch ${r.kept.branch} kept in ${r.kept.path} (${[r.kept.commits ? `${r.kept.commits} commit(s)` : '', r.kept.dirty ? 'uncommitted changes' : ''].filter(Boolean).join(', ')})`
    : '';
  return `${r.id} "${r.title}" ${what}${kept}`;
}

/** Everything cancelling these tasks affects: the tasks themselves, then the waiting tasks cancelled with them. */
export function cancelSet(tasks: Task[], ids: string[]): { picked: Task[]; followers: Task[] } {
  const picked = ids.map((id) => tasks.find((t) => t.id === id)).filter((t): t is Task => !!t && isQueued(t));
  const pickedIds = new Set(picked.map((t) => t.id));
  const followers: Task[] = [];
  for (const t of picked) {
    if (statusAfterCancel(t) !== 'cancelled') continue;
    for (const f of followersOf(tasks, t.id)) {
      if (!pickedIds.has(f.id) && !followers.includes(f)) followers.push(f);
    }
  }
  return { picked, followers };
}
