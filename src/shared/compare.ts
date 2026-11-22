// Best of two: one task given to two Workers on different models, so the user compares the attempts and picks one.
// Each attempt stops at a commit on its own branch; only the picked one is pushed and gets a PR.

import type { Provider, Task } from './types';

/** Added to each attempt's instructions. */
export const COMPARE_NOTE = [
  'This is one of two attempts at the same task, made by different models so the user can compare them.',
  'Do the work and commit it on your branch, but do NOT push and do NOT open a PR.',
  'Finish with a report of what you changed and the trade-offs of your approach. If the user picks your attempt, you will be told to open the PR.',
].join(' ');

/** What the picked attempt's Worker is told. */
export const PICK_MESSAGE = '[Picked] The user compared the two attempts and picked yours. Push the branch and open the PR as you would for any task, then report the PR.';

/**
 * The two models for a comparison: the Worker model, and one that differs from it as much as the accounts allow.
 * First a model of another provider that has an account, then the design model, then any other model of the same
 * provider. Null when there is no second model.
 */
export function compareModels(
  workerModel: string, designModel: string,
  models: readonly { id: string; provider: Provider }[], providers: readonly Provider[],
): [string, string] | null {
  const own = models.find((m) => m.id === workerModel)?.provider ?? (/^claude/i.test(workerModel) ? 'claude' : 'chatgpt');
  const usable = models.filter((m) => providers.includes(m.provider) && m.id !== workerModel);
  const other = usable.find((m) => m.provider !== own)?.id
    ?? (designModel && designModel !== workerModel ? designModel : undefined)
    ?? usable[0]?.id;
  return other ? [workerModel, other] : null;
}

export interface CompareGroup {
  group: string;
  tasks: Task[];
  /** Every attempt has ended, one way or another. */
  settled: boolean;
}

const ENDED: ReadonlySet<Task['status']> = new Set(['done', 'pr_open', 'failed', 'cancelled']);

/** Comparisons still waiting for a pick, oldest first. */
export function openComparisons(tasks: readonly Task[]): CompareGroup[] {
  const groups = new Map<string, Task[]>();
  for (const x of tasks) if (x.compare && !x.compare.picked) groups.set(x.compare.group, [...(groups.get(x.compare.group) ?? []), x]);
  return [...groups.entries()].map(([group, ts]) => ({ group, tasks: ts, settled: ts.every((x) => ENDED.has(x.status)) }));
}

/** Can this attempt be picked: it finished with something to show. */
export function canPick(x: Pick<Task, 'status'>): boolean {
  return x.status === 'done';
}
