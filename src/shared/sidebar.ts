// What the sidebar lists: running Workers by repository, and the tasks finished most recently.

export interface RepoGroup<T> { repo: string | null; items: T[] }

/**
 * Items by repository, each group in the order its first item came, items in their own order.
 * Work outside any repository (repo null) is one group, listed last.
 */
export function groupByRepo<T>(items: readonly T[], repoOf: (x: T) => string | null | undefined): RepoGroup<T>[] {
  const groups = new Map<string | null, T[]>();
  for (const x of items) {
    const repo = repoOf(x) || null;
    const g = groups.get(repo);
    if (g) g.push(x);
    else groups.set(repo, [x]);
  }
  const out = [...groups].map(([repo, list]) => ({ repo, items: list }));
  return [...out.filter((g) => g.repo !== null), ...out.filter((g) => g.repo === null)];
}

/** How many finished tasks "Done today" lists under its heading. */
export const DONE_SHOWN = 8;

/** The `n` tasks that finished last, newest first. Tasks without a finish time are left out. */
export function recentlyFinished<T extends { finishedAt: string | null }>(tasks: readonly T[], n = DONE_SHOWN): T[] {
  return tasks.filter((x) => !!x.finishedAt).sort((a, b) => b.finishedAt!.localeCompare(a.finishedAt!)).slice(0, n);
}
