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

export type MergeMethod = 'squash' | 'merge' | 'rebase';

/** The way to merge that the repository allows, preferring a squash, then a merge commit, then a rebase. */
export function mergeMethod(repo: { squashMergeAllowed?: boolean; mergeCommitAllowed?: boolean; rebaseMergeAllowed?: boolean } | null | undefined): MergeMethod {
  if (!repo || repo.squashMergeAllowed !== false) return 'squash';
  if (repo.mergeCommitAllowed !== false) return 'merge';
  return 'rebase';
}
