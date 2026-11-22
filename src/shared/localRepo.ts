// A repository registered from a local folder with no `origin` remote: Workers branch from its local default branch
// and commit there; nothing is fetched, pushed or opened as a PR. Kept here so it can be tested.
import type { Repo } from './types';

export const isLocalRepo = (repo: Pick<Repo, 'local'> | null | undefined) => !!repo?.local;

/** What a Worker's worktree and task branches start from: `origin/<default>`, or the local default branch. */
export function baseRef(repo: Pick<Repo, 'local' | 'defaultBranch'>) {
  return repo.local ? repo.defaultBranch : `origin/${repo.defaultBranch}`;
}

/**
 * The default branch of a repository without a remote: the branch checked out, else init.defaultBranch, else main
 * or master, else the first branch there is. Only branches that exist (have a commit) count. Null when there is none.
 */
export function pickLocalDefault(current: string, initDefault: string, branches: string[]): string | null {
  for (const b of [current, initDefault, 'main', 'master']) if (b && branches.includes(b)) return b;
  return branches[0] ?? null;
}

/** The task message lines for a local-only repository, replacing the fetch, push and PR steps. */
export function localTaskLines(repo: Pick<Repo, 'defaultBranch'>, branch: string) {
  return [
    `Branch: ${branch}. Start with \`git switch -c ${branch} ${repo.defaultBranch}\`. If you are already on that branch, continue there.`,
    'This repository is local only: it has no remote. Do not fetch, push or open a PR, and do not run `gh`; this overrides the PR steps in your instructions.',
    `When done, commit your work on ${branch} and report with the RESULT line and no PR line; the user merges the branch locally.`,
  ];
}
