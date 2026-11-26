// Getting an open PR merged: handing a conflict with its base to the Worker, and merging it from the app.

import type { PrChecks } from './types';

/**
 * A conflict to hand to the Worker: the PR conflicts with its base, and this pair of head and base commits was not
 * handed over before. Marks it on the task, so one conflict is sent once; a base that moves again is a new one.
 */
export function planConflictFix(task: { conflictSeen?: string }, conflicts: boolean, headSha: string, baseSha: string): boolean {
  if (!conflicts || !headSha || !baseSha) return false;
  const key = `${headSha.slice(0, 12)}:${baseSha.slice(0, 12)}`;
  if (task.conflictSeen === key) return false;
  task.conflictSeen = key;
  return true;
}

/** What the Worker is told to do about a conflict. Merging the base in keeps the branch's history, so no force-push. */
export function conflictBody(base: string): string {
  return [
    `Run \`git fetch origin\` and merge \`origin/${base}\` into the branch. Do not rebase and do not force-push.`,
    'Resolve each conflict so that both changes keep working: read what the other side changed and why before choosing.',
    'Run the tests and the build, commit the merge, and push.',
    'If a conflict needs a decision about which behaviour wins, ask instead of guessing.',
  ].join('\n');
}

/** Can the PR be merged now: no failed or running checks, no conflicts, and no review still asked for. */
export function canMerge(c: PrChecks | null | undefined): boolean {
  return !!c && (c.ci === 'passing' || c.ci === 'none') && !c.conflicts && c.review !== 'changes' && c.review !== 'required';
}

/** What an open PR waits for before it can be merged; each names when the Merge button opens. */
export type MergeWait = 'queued' | 'worker' | 'ci' | 'ciFailed' | 'conflicts' | 'changes' | 'review';

/**
 * The first thing an open PR waits for before it can be merged, or null when it can be merged now.
 * `busy`: a Worker is still at work on the PR, so its head is about to change (as in readyToMerge).
 * `queued`: it is in the merge queue already (shared/mergeQueue.ts), which merges it when its turn comes.
 */
export function mergeWait(c: PrChecks, busy = false, queued = false): MergeWait | null {
  if (queued) return 'queued';
  if (busy) return 'worker';
  if (c.ci === 'pending') return 'ci';
  if (c.ci === 'failing') return 'ciFailed';
  if (c.conflicts) return 'conflicts';
  if (c.review === 'changes') return 'changes';
  if (c.review === 'required') return 'review';
  return null;
}

/** The PRs (lower-cased URLs) a Worker is still at work on: queued, running, waiting or blocked. */
export function busyPrs(tasks: readonly { prUrl: string | null; status: string }[]): Set<string> {
  return new Set(tasks.filter((x) => x.prUrl && (x.status === 'running' || x.status === 'waiting' || x.status === 'queued' || x.status === 'blocked')).map((x) => x.prUrl!.toLowerCase()));
}

export type MergeMethod = 'squash' | 'merge' | 'rebase';

/** The way to merge that the repository allows, preferring a squash, then a merge commit, then a rebase. */
export function mergeMethod(repo: { squashMergeAllowed?: boolean; mergeCommitAllowed?: boolean; rebaseMergeAllowed?: boolean } | null | undefined): MergeMethod {
  if (!repo || repo.squashMergeAllowed !== false) return 'squash';
  if (repo.mergeCommitAllowed !== false) return 'merge';
  return 'rebase';
}

/**
 * The open PRs that can be merged now, one task per PR in the order given: what "Merge N" merges.
 * A PR whose Worker is still at work on it is left out, since its head is about to change.
 */
export function readyToMerge<T extends { id: string; prUrl: string | null; prState: string | null; status: string; prChecks?: PrChecks | null }>(tasks: readonly T[]): T[] {
  const seen = new Set<string>();
  const busy = busyPrs(tasks);
  const out: T[] = [];
  for (const x of tasks) {
    if (!x.prUrl || x.prState !== 'OPEN' || !canMerge(x.prChecks)) continue;
    const key = x.prUrl.toLowerCase();
    if (seen.has(key) || busy.has(key)) continue;
    seen.add(key);
    out.push(x);
  }
  return out;
}
