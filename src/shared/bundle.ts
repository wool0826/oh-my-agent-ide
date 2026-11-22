// One request that changes several repositories: its tasks are shown together, and their PRs merge in order (decision 126).

import type { PrChecks, Task } from './types';
import { canMerge } from './prMerge';

type BundleTask = Pick<Task, 'id' | 'status' | 'prUrl' | 'prState' | 'createdAt'> & { bundle?: string | null; prChecks?: PrChecks | null };

export interface Bundle<T extends BundleTask> {
  name: string;
  /** In the order the Dispatcher made them, which is the order their PRs merge in. */
  tasks: T[];
  /** Every task has an open PR that can be merged now. */
  ready: boolean;
}

/** A bundle's name as the Dispatcher gave it, trimmed to one short line; null when there is none. */
export function bundleName(v: unknown): string | null {
  const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 60) : '';
  return s || null;
}

const over = (t: BundleTask) => t.prState === 'MERGED' || t.prState === 'CLOSED' || t.status === 'cancelled';

/**
 * Bundles still worth showing: two or more tasks, at least one not yet merged, closed or cancelled.
 * A bundle of one is just a task, and a finished bundle leaves the inbox.
 */
export function openBundles<T extends BundleTask>(tasks: readonly T[]): Bundle<T>[] {
  const groups = new Map<string, T[]>();
  for (const x of tasks) if (x.bundle) groups.set(x.bundle, [...(groups.get(x.bundle) ?? []), x]);
  const out: Bundle<T>[] = [];
  for (const [name, list] of groups) {
    if (list.length < 2 || list.every(over)) continue;
    const ts = list.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const left = ts.filter((x) => !over(x));
    out.push({ name, tasks: ts, ready: left.every((x) => !!x.prUrl && x.prState === 'OPEN' && x.status !== 'running' && x.status !== 'waiting' && canMerge(x.prChecks)) });
  }
  return out;
}

/** The tasks "Merge in order" merges: the bundle's open PRs, first made first. */
export function bundleMergeOrder<T extends BundleTask>(b: Bundle<T>): T[] {
  return b.tasks.filter((x) => !!x.prUrl && x.prState === 'OPEN');
}
