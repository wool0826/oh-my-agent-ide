// Several tasks can record the same PR: a follow-up that resolves conflicts or adds to an
// open PR pushes to its branch and reports the same URL. The PR is still one thing, so the
// lists show it once and the PR monitor handles it once.
// Shared by the main process (PR monitor) and the renderer (sidebar, repositories).

import type { Task } from './types';

type PrTask = Pick<Task, 'prUrl' | 'prState' | 'status'>;

/** Identifies a PR whatever the URL's scheme, case or trailing path (`/files`, `#issuecomment-…`). */
export function prKey(url: string): string {
  const m = url.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)/i);
  return (m ? `${m[1]}/${m[2]}/${m[3]}/${m[4]}` : url.trim()).toLowerCase();
}

const settled = (t: PrTask) => t.prState === 'MERGED' || t.prState === 'CLOSED';

/** Working on the PR, or about to: fixing review comments or CI, a follow-up, or that work paused by a limit. */
const working = (t: PrTask) => t.status === 'running' || t.status === 'waiting' || t.status === 'queued' || t.status === 'blocked';

/** Tasks grouped by PR, in the order given. In store order the first task of each group is the one that opened the PR. */
export function byPr<T extends PrTask>(tasks: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const t of tasks) {
    if (!t.prUrl) continue;
    const k = prKey(t.prUrl);
    const g = out.get(k);
    if (g) g.push(t);
    else out.set(k, [t]);
  }
  return out;
}

/** Some task is working on this open PR, so new review comments and failed CI wait. */
export function prBusy(all: PrTask[]): boolean {
  return all.some((t) => !settled(t) && working(t));
}

/**
 * PRs in review, one task each: the first one that recorded the PR (it opened the PR, and its title says what the PR is).
 * A PR that a task is working on again is left out, like a single task fixing review comments: that work shows under Running or Queue.
 */
export function prsInReview<T extends PrTask>(tasks: T[]): T[] {
  const out: T[] = [];
  for (const group of byPr(tasks).values()) {
    if (prBusy(group)) continue;
    const first = group.find((t) => t.status === 'pr_open' && !settled(t));
    if (first) out.push(first);
  }
  return out;
}

export interface PrWatch<T> {
  url: string;
  /** Tasks to check, settle on merge and keep readiness on: open PR, in review or being fixed. The first one gets comments and CI. */
  tasks: T[];
  /** Every task that recorded the PR, finished ones included. */
  all: T[];
  /** Another task already saw this PR merged or closed: settle the rest without announcing it again. */
  announced: boolean;
}

/** The PRs the monitor checks, each once. */
export function prsToWatch<T extends PrTask>(tasks: T[]): PrWatch<T>[] {
  const out: PrWatch<T>[] = [];
  for (const all of byPr(tasks).values()) {
    const open = all.filter((t) => !settled(t) && (t.status === 'pr_open' || t.status === 'running'));
    if (open.length) out.push({ url: open[0].prUrl!, tasks: open, all, announced: all.some(settled) });
  }
  return out;
}

/**
 * Before the first task handles new comments or failed CI, give it what every task on the PR already handled,
 * so a follow-up that recorded the PR later never gets old comments or runs again.
 */
export function adoptSeen(owner: Pick<Task, 'seenCommentIds' | 'seenCiRuns' | 'ciFixAttempts'>, all: Pick<Task, 'seenCommentIds' | 'seenCiRuns' | 'ciFixAttempts'>[]) {
  owner.seenCommentIds = [...new Set([...owner.seenCommentIds, ...all.flatMap((t) => t.seenCommentIds ?? [])])];
  const runs = [...new Set([...(owner.seenCiRuns ?? []), ...all.flatMap((t) => t.seenCiRuns ?? [])])];
  if (runs.length) owner.seenCiRuns = runs.slice(-200);
  const attempts = Math.max(owner.ciFixAttempts ?? 0, ...all.map((t) => t.ciFixAttempts ?? 0));
  if (attempts) owner.ciFixAttempts = attempts;
}
