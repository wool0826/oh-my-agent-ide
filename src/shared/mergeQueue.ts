// The merge queue: ready PRs are merged one at a time, each on the base the merge before it produced (decision 210).
// The rules only; src/main/prmonitor.ts reads GitHub and carries out each step.

import type { Key } from './i18n';
import type { MergeQueueEntry, MergeQueueLeft, MergeQueuePhase, PrChecks, Task } from './types';
import { busyPrs, canMerge, readyToMerge } from './prMerge';

export const MERGE_QUEUE = {
  /** How often the PR at the front is read while it waits. */
  tick: 15_000,
  /** The same while GitHub is about to answer: the branch is being updated, or it still works out whether the PR merges. */
  tickSoon: 3_000,
  /** How long into a phase the short tick is used; an answer that takes longer is asked for at the usual pace. */
  soonFor: 60_000,
  /** Longest wait for a PR's checks to end. */
  checksMax: 60 * 60_000,
  /** Longest wait for checks to show up on a head the base was just taken into. */
  checksAppear: 3 * 60_000,
  /** Longest wait for the branch to move after the base was asked into it. */
  headMoves: 3 * 60_000,
  /** Times the base is taken into one PR before the queue gives up on it (the base keeps moving). */
  maxUpdates: 3,
  /** Times in a row GitHub may refuse to take the base in (not for a conflict) before the PR leaves. */
  maxFails: 3,
};

type QueueTask = Pick<Task, 'id' | 'prUrl' | 'prState' | 'createdAt'> & { bundle?: string | null };

const key = (url: string) => url.toLowerCase();
const active = (e: MergeQueueEntry) => !e.left;

/** The PR whose turn it is: the first still in the queue. */
export function headEntry(queue: readonly MergeQueueEntry[]): MergeQueueEntry | null {
  return queue.find(active) ?? null;
}

/** The PRs (lower-cased URLs) in the queue now; ones that left do not count. */
export function queuedPrs(queue: readonly MergeQueueEntry[]): Set<string> {
  return new Set(queue.filter(active).map((e) => key(e.prUrl)));
}

/** What "Merge N" adds: the PRs that can be merged now and are not in the queue yet, one task per PR. */
export function readyToQueue<T extends Parameters<typeof readyToMerge>[0][number]>(tasks: readonly T[], queue: readonly MergeQueueEntry[]): T[] {
  const queued = queuedPrs(queue);
  return readyToMerge(tasks).filter((x) => !queued.has(key(x.prUrl!)));
}

/**
 * Add tasks' open PRs at the back, in the order given, each PR once. One that left the queue comes back at the back.
 * The PRs of one bundle keep the order their tasks were made in, whatever order they were added in.
 */
export function enqueue(queue: readonly MergeQueueEntry[], tasks: readonly QueueTask[], ids: readonly string[], now: string): MergeQueueEntry[] {
  let out = queue.slice();
  for (const id of ids) {
    const task = tasks.find((x) => x.id === id);
    if (!task?.prUrl || task.prState !== 'OPEN') continue;
    const k = key(task.prUrl);
    if (out.some((e) => active(e) && key(e.prUrl) === k)) continue;
    out = out.filter((e) => key(e.prUrl) !== k);
    out.push({ taskId: task.id, prUrl: task.prUrl, group: task.bundle ?? null, phase: 'waiting', since: now });
  }
  // Each bundle's entries take the places they hold, first made first.
  const made = (e: MergeQueueEntry) => tasks.find((x) => x.id === e.taskId)?.createdAt ?? '';
  for (const group of new Set(out.filter((e) => active(e) && e.group).map((e) => e.group!))) {
    const at = out.flatMap((e, i) => (active(e) && e.group === group ? [i] : []));
    const sorted = at.map((i) => out[i]).sort((a, b) => made(a).localeCompare(made(b)));
    at.forEach((i, n) => { out[i] = sorted[n]; });
  }
  return out;
}

/** The later PRs of a bundle leave with the one that left: they may depend on it (decision 126). */
function stopBundle(queue: MergeQueueEntry[], from: number, group: string | null | undefined, now: string): MergeQueueEntry[] {
  if (!group) return queue;
  return queue.map((e, i) => (i > from && active(e) && e.group === group ? { ...e, left: { why: 'bundle' as const, at: now } } : e));
}

/** The PR leaves the queue and keeps saying why; the rest go on, except the later PRs of its bundle. */
export function leave(queue: readonly MergeQueueEntry[], taskId: string, why: MergeQueueLeft, now: string, detail?: string): MergeQueueEntry[] {
  const i = queue.findIndex((e) => e.taskId === taskId && active(e));
  if (i < 0) return queue.slice();
  const out = queue.map((e, n) => (n === i ? { ...e, left: { why, at: now, ...(detail ? { detail } : {}) } } : e));
  return stopBundle(out, i, queue[i].group, now);
}

/** The user takes a PR out (or clears the line of one that left). Taking one out stops the later PRs of its bundle. */
export function removeEntry(queue: readonly MergeQueueEntry[], taskId: string, now: string): MergeQueueEntry[] {
  const i = queue.findIndex((e) => e.taskId === taskId);
  if (i < 0) return queue.slice();
  const out = active(queue[i]) ? stopBundle(queue.slice(), i, queue[i].group, now) : queue.slice();
  out.splice(i, 1);
  return out;
}

/** The PR was merged: its entry goes, and nothing else changes. */
export function merged(queue: readonly MergeQueueEntry[], taskId: string): MergeQueueEntry[] {
  return queue.filter((e) => e.taskId !== taskId);
}

/**
 * Drop what no longer belongs: a merged PR's entry, and one whose PR was closed or whose task is gone, which stops
 * the later PRs of its bundle as taking it out would. The same array comes back when nothing changed.
 */
export function prune(queue: readonly MergeQueueEntry[], tasks: readonly QueueTask[], now: string): readonly MergeQueueEntry[] {
  let out: readonly MergeQueueEntry[] = queue;
  for (const e of queue) {
    const state = tasks.find((x) => x.id === e.taskId)?.prState ?? null;
    if (state === 'OPEN') continue;
    out = state === 'MERGED' ? merged(out, e.taskId) : removeEntry(out, e.taskId, now);
  }
  return out;
}

/** What GitHub says about the PR at the front, read fresh for every step. */
export interface QueueFacts {
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  headSha: string;
  /** Commits on the base that the branch does not have; null when that could not be read. */
  behind: number | null;
  /** GitHub's own word: MERGEABLE, CONFLICTING, or UNKNOWN while it still works it out. */
  mergeable: string;
  checks: PrChecks;
  /** The checks on the head, by name, whatever their state. */
  names: readonly string[];
  /** A Worker is at work on the PR, so its head is about to change. */
  busy: boolean;
}

export type QueueStep =
  /** Merged already: the entry goes and the next PR has its turn. */
  | { do: 'done' }
  /** Closed without merging: the entry goes, with the later PRs of its bundle. */
  | { do: 'gone' }
  | { do: 'wait'; phase: MergeQueuePhase }
  /** Take the base into the branch. */
  | { do: 'update' }
  | { do: 'merge' }
  | { do: 'leave'; why: MergeQueueLeft };

/**
 * The next step for the PR at the front. Nothing is remembered between steps but what the entry holds, so the
 * queue goes on from the same place after a restart.
 */
export function nextStep(entry: MergeQueueEntry, f: QueueFacts, now: number): QueueStep {
  if (f.state === 'MERGED') return { do: 'done' };
  if (f.state === 'CLOSED') return { do: 'gone' };
  if (f.busy) return { do: 'leave', why: 'worker' };
  if (f.checks.conflicts) return { do: 'leave', why: 'conflict' };
  // Time spent in a phase counts only while the entry is in it: a phase it is about to enter starts now.
  const spent = (p: MergeQueuePhase) => (entry.phase === p ? now - Date.parse(entry.since) : 0);
  const waitChecks = (max: number): QueueStep => (spent('checks') > max ? { do: 'leave', why: 'timeout' } : { do: 'wait', phase: 'checks' });
  // The base was asked into the branch and the branch has not moved yet: what is read is still the old head.
  if (entry.phase === 'updating' && entry.updatedFrom && f.headSha === entry.updatedFrom) {
    return spent('updating') > MERGE_QUEUE.headMoves ? { do: 'leave', why: 'updateFailed' } : { do: 'wait', phase: 'updating' };
  }
  if (f.checks.review === 'changes') return { do: 'leave', why: 'changes' };
  if (f.checks.review === 'required') return { do: 'leave', why: 'review' };
  if (f.checks.ci === 'failing') return { do: 'leave', why: 'ciFailed' };
  if (f.mergeable !== 'MERGEABLE' || f.behind === null) return waitChecks(MERGE_QUEUE.checksMax);
  if (f.behind > 0) return (entry.updates ?? 0) >= MERGE_QUEUE.maxUpdates ? { do: 'leave', why: 'baseMoved' } : { do: 'update' };
  if (f.checks.ci === 'pending') return waitChecks(MERGE_QUEUE.checksMax);
  if (entry.expectChecks && entry.updatedFrom) {
    // Right after the base was taken, the new head has no checks yet: "none" there means "not started", not "nothing to pass".
    if (f.checks.ci === 'none') return waitChecks(MERGE_QUEUE.checksAppear);
    // They start one by one: a quick one has passed while another the old head had is not there yet. Those get the
    // same time to show up; after it, the ones that ran decide (a check the base dropped never comes).
    const missing = (entry.expectNames ?? []).some((n) => !f.names.includes(n));
    if (missing && spent('checks') <= MERGE_QUEUE.checksAppear) return { do: 'wait', phase: 'checks' };
  }
  return { do: 'merge' };
}

/**
 * How long until the PR at the front is read again: soon while GitHub is in the middle of something short (the
 * branch is being updated, or it still works out whether the PR merges), for the first minute of the phase.
 */
export function tickAfter(entry: MergeQueueEntry, mergeable: string, now: number): number {
  const short = entry.phase === 'updating' || (mergeable !== 'MERGEABLE' && mergeable !== 'CONFLICTING');
  return short && now - Date.parse(entry.since) < MERGE_QUEUE.soonFor ? MERGE_QUEUE.tickSoon : MERGE_QUEUE.tick;
}

/** The entry once the base was asked into its branch: it waits for the branch to move off the head read just now. */
export function updating(entry: MergeQueueEntry, f: Pick<QueueFacts, 'headSha' | 'checks' | 'names'>, now: string): MergeQueueEntry {
  return {
    ...entry, phase: 'updating', since: now, updatedFrom: f.headSha, updates: (entry.updates ?? 0) + 1, fails: 0,
    expectChecks: !!entry.expectChecks || f.checks.ci !== 'none',
    expectNames: f.names.length ? [...f.names] : entry.expectNames ?? [],
  };
}

/**
 * GitHub refused to take the base in, and not for a conflict (the head moved under the request, a short outage):
 * the entry to try again with at the next read, or null once it has been refused too often.
 */
export function updateRefused(entry: MergeQueueEntry): MergeQueueEntry | null {
  const fails = (entry.fails ?? 0) + 1;
  return fails >= MERGE_QUEUE.maxFails ? null : { ...entry, fails };
}

/** The entries that left between two states of the queue: what the user and the Dispatcher are told about. */
export function newlyLeft(before: readonly MergeQueueEntry[], after: readonly MergeQueueEntry[]): MergeQueueEntry[] {
  return after.filter((e) => e.left && !before.find((b) => b.taskId === e.taskId)?.left);
}

/** The entry in a phase; the phase's clock starts only when it enters it. */
export function inPhase(entry: MergeQueueEntry, phase: MergeQueuePhase, now: string): MergeQueueEntry {
  return entry.phase === phase ? entry : { ...entry, phase, since: now };
}

type RowTask = Pick<Task, 'id' | 'title' | 'repo' | 'workerId' | 'prUrl' | 'prState' | 'status'> & { prChecks?: PrChecks | null };

/** One line of the queue as the Workers view shows it. */
export interface QueueRow {
  taskId: string;
  prUrl: string;
  /** The PR's number, from its URL. */
  num: string;
  title: string;
  repo: string | null;
  workerId: string | null;
  group: string | null;
  /** Its place in line, from 1; null once it left. */
  pos: number | null;
  state: MergeQueuePhase | 'left';
  why: MergeQueueLeft | null;
  detail: string | null;
  /** It left, and can be merged again now: it can be put back. */
  again: boolean;
}

/** The queue for the screen: the PRs in line in their order, then the ones that left. */
export function queueRows(queue: readonly MergeQueueEntry[], tasks: readonly RowTask[]): QueueRow[] {
  const busy = busyPrs(tasks);
  const rows: QueueRow[] = [];
  let pos = 0;
  for (const e of queue) {
    const task = tasks.find((x) => x.id === e.taskId);
    if (!task) continue;
    const left = e.left ?? null;
    rows.push({
      taskId: e.taskId, prUrl: e.prUrl, num: e.prUrl.match(/\/pull\/(\d+)/)?.[1] ?? '', title: task.title, repo: task.repo ?? null, workerId: task.workerId ?? null,
      group: e.group ?? null, pos: left ? null : ++pos, state: left ? 'left' : e.phase, why: left?.why ?? null, detail: left?.detail ?? null,
      again: !!left && task.prState === 'OPEN' && canMerge(task.prChecks) && !busy.has(key(e.prUrl)),
    });
  }
  return [...rows.filter((r) => r.pos !== null), ...rows.filter((r) => r.pos === null)];
}

const PHASE_KEY: Record<MergeQueuePhase, Key> = { waiting: 'mq.waiting', updating: 'mq.updating', checks: 'mq.checks', merging: 'mq.merging' };
const LEFT_KEY: Record<MergeQueueLeft, Key> = {
  ciFailed: 'mq.left.ciFailed', conflict: 'mq.left.conflict', changes: 'mq.left.changes', review: 'mq.left.review', worker: 'mq.left.worker',
  timeout: 'mq.left.timeout', baseMoved: 'mq.left.baseMoved', updateFailed: 'mq.left.updateFailed', mergeFailed: 'mq.left.mergeFailed', bundle: 'mq.left.bundle',
};

/** The text (its key) for where a PR is in the queue, and for why one left. */
export const phaseKey = (phase: MergeQueuePhase): Key => PHASE_KEY[phase];
export const leftKey = (why: MergeQueueLeft): Key => LEFT_KEY[why];

const LEFT_NOTE: Record<MergeQueueLeft, string> = {
  ciFailed: 'its checks failed',
  conflict: 'it conflicts with its base, and its Worker was told to merge the base in',
  changes: 'a review asks for changes',
  review: 'it still needs a review',
  worker: 'a Worker is at work on it',
  timeout: 'its checks did not finish in time',
  baseMoved: 'its base kept moving while it waited',
  updateFailed: 'the base could not be taken into its branch',
  mergeFailed: 'GitHub refused the merge',
  bundle: 'an earlier PR of its bundle left the queue',
};

/** What the Dispatcher hears when a PR leaves the queue. */
export function leftNote(task: Pick<Task, 'id' | 'title' | 'prUrl'>, why: MergeQueueLeft, detail?: string | null): string {
  return `${task.id} "${task.title}" left the merge queue without being merged: ${LEFT_NOTE[why]}${detail ? ` (${detail})` : ''}. ${task.prUrl ?? ''}`.trim();
}
