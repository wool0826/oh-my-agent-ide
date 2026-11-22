// A Worker's work at a glance, for its Summary tab: the totals over its tasks, and how long each took.

import { addSpend, type Spend } from './spend';
import type { Task } from './types';

export interface WorkerTotals {
  /** Tasks finished: done, or with a PR that was opened. */
  done: number;
  /** Tasks still going: waiting to start, running, or waiting for an answer. */
  open: number;
  failed: number;
  prsOpen: number;
  prsMerged: number;
  /** Result files, each once. */
  files: number;
  spend: Spend | null;
}

/** Totals over a Worker's tasks. A PR that several tasks worked on counts once. */
export function workerTotals(tasks: readonly Task[]): WorkerTotals {
  const prs = new Map<string, Task['prState']>();
  const files = new Set<string>();
  let spend: Spend | null = null;
  const out: WorkerTotals = { done: 0, open: 0, failed: 0, prsOpen: 0, prsMerged: 0, files: 0, spend: null };
  for (const x of tasks) {
    if (x.status === 'done' || x.status === 'pr_open') out.done++;
    else if (x.status === 'failed') out.failed++;
    else if (x.status !== 'cancelled') out.open++;
    if (x.prUrl) prs.set(x.prUrl, x.prState === 'MERGED' || prs.get(x.prUrl) === 'MERGED' ? 'MERGED' : x.prState ?? prs.get(x.prUrl) ?? null);
    for (const f of x.files) files.add(f);
    if (x.spend) spend = addSpend(spend, x.spend);
  }
  for (const st of prs.values()) { if (st === 'MERGED') out.prsMerged++; else if (st !== 'CLOSED') out.prsOpen++; }
  out.files = files.size;
  out.spend = spend;
  return out;
}

/**
 * How long a task took, in minutes: from when it reached the Worker to when it finished (or to `now` while it
 * runs). Null when it never started.
 */
export function taskMinutes(x: Pick<Task, 'startedAt' | 'finishedAt' | 'status'>, now = Date.now()): number | null {
  if (!x.startedAt) return null;
  const end = x.finishedAt ? Date.parse(x.finishedAt) : x.status === 'running' || x.status === 'waiting' ? now : NaN;
  const mins = Math.round((end - Date.parse(x.startedAt)) / 60_000);
  return Number.isFinite(mins) && mins >= 0 ? mins : null;
}
