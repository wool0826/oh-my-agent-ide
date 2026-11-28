// Which tasks the user can cancel from the queue, and what cancelling one does.
// Shared by the main process (which cancels) and the renderer (which asks first).

import { COMPARE_NOTE } from './compare';
import type { Effort, Task, TaskStatus } from './types';

/** Waiting to start: paused by a usage limit (queued) or waiting for another task's PR to merge (blocked). */
export function isQueued(t: Pick<Task, 'status'>): boolean {
  return t.status === 'queued' || t.status === 'blocked';
}

/**
 * Keep the time each task entered the queue (L13). Called on every state change: a task seen queued for the first
 * time takes its updatedAt, which every queueing sets; one that left the queue loses it. Says whether anything changed.
 */
export function stampQueued(tasks: (Pick<Task, 'status' | 'updatedAt' | 'queuedSince'> & Partial<Pick<Task, 'queueRank' | 'queuePinned'>>)[]): boolean {
  let changed = false;
  for (const t of tasks) {
    const q = isQueued(t);
    if (q && !t.queuedSince) { t.queuedSince = t.updatedAt; changed = true; }
    else if (!q && t.queuedSince) { t.queuedSince = null; changed = true; }
    // A place or pin the user gave is for this wait only: queued again, the task joins at the back.
    if (!q && (t.queueRank != null || t.queuePinned)) { t.queueRank = null; t.queuePinned = false; changed = true; }
  }
  return changed;
}

// The queue's one order (11B): the sidebar's queue and the board's waiting column both show it, and the slots are
// filled in it. Pinned tasks come first; within each group a task the user moved goes by its rank, any other by the
// time it joined, so a task queued later joins at the back.

type Ranked = Pick<Task, 'id' | 'updatedAt'> & Partial<Pick<Task, 'queuedSince' | 'queueRank' | 'queuePinned'>>;

/**
 * Where a task stands in its group: its rank, or the time it joined the line. A task that waited for a merge keeps
 * its queuedSince, but joins the line for a slot when the hold clears (its updatedAt), behind the tasks already there.
 */
export function queueKey(t: Ranked): number {
  return t.queueRank ?? Math.max(Date.parse(t.queuedSince ?? '') || 0, Date.parse(t.updatedAt) || 0);
}

/** The queue's order: pinned first, then by queueKey, then by id. */
export function byQueue(a: Ranked, b: Ranked): number {
  return Number(!!b.queuePinned) - Number(!!a.queuePinned) || queueKey(a) - queueKey(b) || a.id.localeCompare(b.id);
}

/**
 * up/down: one place, within its group (pinned or not). top: first of its group. next: first of all, pinned when a
 * pinned task was ahead. pin: pinned or not, nothing else. before: dropped before that task (null: at the end).
 */
export type QueueMove = 'up' | 'down' | 'top' | 'next' | 'pin' | { before: string | null };

export interface QueueChange { id: string; queueRank: number | null; queuePinned: boolean }

/** Where a dragged row lands: before the first row whose middle is below the pointer, or at the end (null). */
export function dropBefore(rows: { id: string; top: number; height: number }[], y: number): string | null {
  return rows.find((r) => y < r.top + r.height / 2)?.id ?? null;
}

/** A move the window sent, or null when it is not one. */
export function parseQueueMove(v: unknown): QueueMove | null {
  if (v === 'up' || v === 'down' || v === 'top' || v === 'next' || v === 'pin') return v;
  const b = (v as { before?: unknown } | null)?.before;
  return b === null || (typeof b === 'string' && b) ? { before: b } : null;
}

/**
 * What moving `id` in `line` (the tasks waiting for a slot, in queue order) changes, or null when it cannot move
 * that way: already first or last of its group, or a task not in the line (one held by a merge), which can only be
 * pinned. The tasks of the line keep the keys they had, handed out again in the new order, so a task that joins later
 * still joins at the back.
 */
export function moveQueued<T extends Ranked>(line: T[], id: string, move: QueueMove, held?: T | null): QueueChange[] | null {
  const i = line.findIndex((x) => x.id === id);
  const self = i < 0 ? held : line[i];
  if (!self || self.id !== id) return null;
  const pinned = !!self.queuePinned;
  if (move === 'pin') return [{ id, queueRank: self.queueRank ?? null, queuePinned: !pinned }];
  if (i < 0) return null;
  const order = line.map((x) => ({ x, pinned: !!x.queuePinned }));
  const me = order[i]!;
  const pins = order.filter((o) => o.pinned).length;
  const [lo, hi] = pinned ? [0, pins - 1] : [pins, order.length - 1];
  let to: number;
  if (move === 'up') to = i - 1;
  else if (move === 'down') to = i + 1;
  else if (move === 'top') to = lo;
  else if (move === 'next') to = 0;
  else {
    const at = move.before === null ? order.length : order.findIndex((o) => o.x.id === move.before);
    if (at < 0) return null;
    to = at > i ? at - 1 : at;
  }
  if (typeof move === 'string' && move !== 'next' && (to < lo || to > hi)) return null;
  if (to === i && (move !== 'next' || pinned || !pins)) return null;
  order.splice(i, 1);
  order.splice(to, 0, me);
  // Next goes ahead of the pinned tasks too, so it is pinned with them. A drop takes the pin of where it lands: pinned
  // above a pinned task; kept at the edge between the two groups; not pinned among the others.
  if (move === 'next') me.pinned = me.pinned || pins > 0;
  else if (typeof move !== 'string') {
    const prev = order[to - 1], next = order[to + 1];
    me.pinned = !!next?.pinned || (pinned && (!prev || prev.pinned));
  }
  const keys = line.map(queueKey).sort((a, b) => a - b);
  const out: QueueChange[] = [];
  let last = -Infinity;
  order.forEach((o, k) => {
    const rank = Math.max(keys[k]!, last + 1);
    last = rank;
    if (rank !== queueKey(o.x) || o.pinned !== !!o.x.queuePinned || o.x.queueRank == null) out.push({ id: o.x.id, queueRank: rank, queuePinned: o.pinned });
  });
  return out.length ? out : null;
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

/** A PR GitHub lists for a branch (`gh pr list --json url,state,headRefName,isCrossRepository`). */
export interface BranchPr { url: string; state: string; headRefName?: string; isCrossRepository?: boolean }

/**
 * Ask GitHub for the PR of a finished task's branch before the tasks waiting on it start (T-0136): its Worker may have
 * opened one without a RESULT line naming it. Once per finish, and not on a local-only repository (no PRs there).
 */
export function branchPrDue(dep: Pick<Task, 'kind' | 'branch' | 'repo' | 'prUrl' | 'status'>, local: boolean, checked: boolean): boolean {
  return !checked && !local && dep.status === 'done' && dep.kind === 'code' && !!dep.branch && !!dep.repo && !dep.prUrl;
}

/**
 * The task's PR among its branch's: an open one, else a merged one. A closed PR was given up, so it is not the task's.
 * `owned` drops the ones of another repository or a fork's branch of the same name (shared/prOwner.ts branchPrOwned).
 */
export function pickBranchPr(list: unknown, owned: (p: BranchPr) => boolean = () => true): { url: string; state: 'OPEN' | 'MERGED' } | null {
  const prs = Array.isArray(list) ? list.filter((p): p is BranchPr => typeof p?.url === 'string' && /\/pull\/\d+$/.test(p.url) && owned(p)) : [];
  const pr = prs.find((p) => p.state === 'OPEN') ?? prs.find((p) => p.state === 'MERGED');
  return pr ? { url: pr.url, state: pr.state as 'OPEN' | 'MERGED' } : null;
}

/** Why the tasks blocked on `dep` are cancelled (afterDependency said cancel): its PR was closed, it is gone, or it failed. */
export type CancelWhy = 'closed' | 'failed' | 'gone';

export function cancelWhy(dep: Pick<Task, 'prState'>, exists: boolean): CancelWhy {
  return dep.prState === 'CLOSED' ? 'closed' : !exists ? 'gone' : 'failed';
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

// Running a task again (4B): from its result row, the same request goes to the back of the queue; edited first, the
// composer's text replaces it. "again" prefers the task's own Worker, "copy" gets a new one.
export type RerunMode = 'again' | 'copy';

/** What createTask gets for a rerun: the request and the settings it ran with, not its place, PR or comparison. */
export interface RerunInput {
  title: string;
  prompt: string;
  kind: Task['kind'];
  repo?: string;
  model_id?: string;
  effort?: Effort;
  plan_first?: boolean;
  new_worker?: boolean;
  rerun_of: string;
}

/** Only a task that ended can be run again: one still waiting or running is the same request already. */
export function canRerun(x: Pick<Task, 'status' | 'prompt'> | null | undefined): boolean {
  return !!x && !!x.prompt.trim() && (x.status === 'done' || x.status === 'failed' || x.status === 'cancelled' || x.status === 'pr_open');
}

export function parseRerunMode(v: unknown): RerunMode | null {
  return v === 'again' || v === 'copy' ? v : null;
}

/**
 * The new task for running `x` again. `model`: what it ran on (its own, else its Worker's). `text`: the request as
 * edited in the composer; empty, the original. One attempt of a comparison runs as a plain task: its note and the
 * model in its title go.
 */
export function rerunInput(x: Task, mode: RerunMode, model: string | null, text?: string | null): RerunInput {
  const own = x.compare ? x.prompt.replace(`\n\n${COMPARE_NOTE}`, '') : x.prompt;
  const title = x.compare ? x.title.replace(/ \([^()]*\)$/, '') : x.title;
  return {
    title,
    prompt: text?.trim() || own,
    kind: x.kind,
    ...(x.kind === 'code' && x.repo ? { repo: x.repo } : {}),
    ...(model ? { model_id: model } : {}),
    ...(x.effort ? { effort: x.effort } : {}),
    ...(x.planFirst ? { plan_first: true } : {}),
    ...(mode === 'copy' ? { new_worker: true } : {}),
    rerun_of: x.id,
  };
}
