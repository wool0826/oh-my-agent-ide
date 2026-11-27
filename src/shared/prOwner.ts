// Which PR a task may record (T-0150). A Worker's report can cite other PRs (an upstream issue, a library's fix):
// only one in the task's own repository, from a code task with a branch, is the task's PR. Anything else is a link.
// Used when a report is read, when a branch's PR is looked up, by the PR monitor, and on load to clear old records.

import { setStatus } from './taskStatus';
import type { Repo, Task } from './types';

export interface RepoRef { host: string; owner: string; repo: string }

const norm = (s: string) => s.toLowerCase().replace(/\.git$/, '');

/** Host, owner and name of a repository from its remote URL: https://host/o/r(.git), git@host:o/r(.git), ssh://git@host[:port]/o/r(.git). */
export function remoteRepo(url: string | null | undefined): RepoRef | null {
  const u = (url ?? '').trim().replace(/\/+$/, '');
  const m = u.match(/^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+)$/i) ?? u.match(/^(?:[^@/]+@)?([^/:]+):([^/]+)\/([^/]+)$/);
  return m ? { host: m[1].toLowerCase(), owner: norm(m[2]), repo: norm(m[3]) } : null;
}

/** The PR URL is a pull request of that repository (same host, owner and name, any case). */
export function prInRepo(prUrl: string, repoUrl: string | null | undefined): boolean {
  const p = prUrl.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/\d+/i);
  const r = remoteRepo(repoUrl);
  return !!p && !!r && p[1].toLowerCase() === r.host && norm(p[2]) === r.owner && norm(p[3]) === r.repo;
}

type OwnerTask = Pick<Task, 'kind' | 'branch'>;
type OwnerRepo = Pick<Repo, 'url' | 'local'> | null | undefined;

/** Only a code task on its own branch in a repository with a remote opens a PR. */
export function canHavePr(task: OwnerTask, repo: OwnerRepo): boolean {
  return task.kind === 'code' && !!task.branch && !!repo && !repo.local && !!remoteRepo(repo.url);
}

/** Every PR URL a report names: those on its PR lines first, then the rest of its words, each once. */
export function prCandidates(text: string): string[] {
  const re = /https?:\/\/[^\s)>\]`'"]+?\/pull\/\d+/g;
  const prLines = text.split('\n').map((l) => l.trim()).filter((l) => /^PR:/i.test(l));
  const urls = [...prLines.flatMap((l) => l.match(re) ?? []), ...(text.match(re) ?? [])];
  return [...new Set(urls)];
}

/** The task's PR among the URLs: the first in its repository, or none (other URLs are only cited). */
export function pickTaskPr(urls: readonly string[], task: OwnerTask, repo: OwnerRepo): string | null {
  if (!canHavePr(task, repo)) return null;
  return urls.find((u) => prInRepo(u, repo!.url)) ?? null;
}

/** A PR GitHub lists for a branch (`gh pr list --json url,state,headRefName,isCrossRepository`). */
export interface ListedPr { url: string; state: string; headRefName?: string; isCrossRepository?: boolean }

/** A listed PR is the task's: in its repository, from its branch, not from a fork's branch of the same name. */
export function branchPrOwned(pr: ListedPr, task: OwnerTask, repo: OwnerRepo): boolean {
  return canHavePr(task, repo) && prInRepo(pr.url, repo!.url) && pr.headRefName === task.branch && pr.isCrossRepository !== true;
}

/** The task may keep the PR it records (none recorded counts as fine). */
export function ownsPr(task: OwnerTask & Pick<Task, 'prUrl'>, repo: OwnerRepo): boolean {
  return !task.prUrl || (canHavePr(task, repo) && prInRepo(task.prUrl, repo!.url));
}

/**
 * A record saved before this check: a PR that is not the task's is dropped (kept as a link), and a task that was
 * in review only because of it is done again. Returns whether it changed anything.
 */
export function clearForeignPr(task: Task, repo: OwnerRepo): boolean {
  if (ownsPr(task, repo)) return false;
  const url = task.prUrl!;
  task.links = task.links?.includes(url) ? task.links : [...(task.links ?? []), url];
  task.prUrl = null;
  task.prState = null;
  task.prChecks = null;
  if (task.status === 'pr_open') setStatus(task, 'done');
  return true;
}

/**
 * clearForeignPr over every task, each with its repository (by name, any case). The ids it changed. A task whose
 * repository is no longer listed, or has a remote this cannot read, keeps what it has: nothing to tell it by.
 */
export function clearForeignPrs(tasks: Task[], repos: readonly Repo[]): string[] {
  const out: string[] = [];
  for (const x of tasks) {
    if (!x.prUrl) continue;
    const repo = x.repo ? repos.find((r) => r.name.toLowerCase() === x.repo!.toLowerCase()) : null;
    if (x.repo && (!repo || (!repo.local && !remoteRepo(repo.url)))) continue;
    if (clearForeignPr(x, repo)) out.push(x.id);
  }
  return out;
}
