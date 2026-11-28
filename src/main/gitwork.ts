import fs from 'node:fs';
import path from 'node:path';
import { run } from './util';

/** What a task branch holds, read from local refs only (a Worker's push updates origin/<branch> here too). */
export interface BranchWork {
  /** refs/heads/<branch> exists in the repository. */
  local: boolean;
  /** refs/remotes/origin/<branch> exists: the branch was pushed. */
  remote: boolean;
  /** Commits on the local or pushed branch that origin/<default> does not have. */
  commits: number;
  /** The worktree has that branch checked out. */
  checkedOut: boolean;
  /** Uncommitted changes (tracked or untracked, not ignored) in the worktree while it is on that branch. */
  dirty: boolean;
}

async function hasRef(cwd: string, ref: string) {
  return (await run('git', ['rev-parse', '--verify', '-q', ref], { cwd })).code === 0;
}

async function ahead(cwd: string, base: string, ref: string) {
  const r = await run('git', ['rev-list', '--count', `${base}..${ref}`], { cwd });
  return r.code === 0 ? Number(r.stdout.trim()) || 0 : 0;
}

/**
 * Read what the branch of a cancelled task holds, so nothing with work in it is deleted. `noRemote`: the repository has
 * no remote, so commits are counted against its local default branch.
 */
export async function inspectBranch(repoPath: string, worktree: string | null, defaultBranch: string, branch: string, noRemote = false): Promise<BranchWork> {
  const base = noRemote ? `refs/heads/${defaultBranch}` : `refs/remotes/origin/${defaultBranch}`;
  const local = await hasRef(repoPath, `refs/heads/${branch}`);
  const remote = await hasRef(repoPath, `refs/remotes/origin/${branch}`);
  let commits = 0;
  if (local) commits = Math.max(commits, await ahead(repoPath, base, `refs/heads/${branch}`));
  if (remote) commits = Math.max(commits, await ahead(repoPath, base, `refs/remotes/origin/${branch}`));
  let checkedOut = false;
  let dirty = false;
  if (worktree && fs.existsSync(worktree)) {
    checkedOut = (await run('git', ['branch', '--show-current'], { cwd: worktree })).stdout.trim() === branch;
    if (checkedOut) dirty = (await run('git', ['status', '--porcelain'], { cwd: worktree })).stdout.trim() !== '';
  }
  return { local, remote, commits, checkedOut, dirty };
}

/**
 * The branch checked out in a worktree and the files it changes against where it left the default branch: committed,
 * uncommitted and untracked (not ignored), a rename as both its paths. `branch` is '' on a detached HEAD, and
 * `hintExists` says whether the branch `hint` exists locally. Null without a common base.
 */
export async function changedFiles(worktree: string, defaultBranch: string, local = false, hint: string | null = null): Promise<{ branch: string; hintExists: boolean; files: string[] } | null> {
  if (!fs.existsSync(path.join(worktree, '.git'))) return null;
  const branch = (await run('git', ['branch', '--show-current'], { cwd: worktree })).stdout.trim();
  const hintExists = !!hint && await hasRef(worktree, `refs/heads/${hint}`);
  const mb = await run('git', ['merge-base', 'HEAD', local ? defaultBranch : `origin/${defaultBranch}`], { cwd: worktree });
  if (mb.code !== 0) return null;
  const diff = await run('git', ['diff', '--name-only', '--no-renames', '-z', mb.stdout.trim()], { cwd: worktree });
  if (diff.code !== 0) return null;
  const untracked = await run('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: worktree });
  const files = new Set([...diff.stdout.split('\0'), ...untracked.stdout.split('\0')].filter(Boolean));
  return { branch, hintExists, files: [...files].sort().slice(0, 1000) };
}

/** No uncommitted changes in the worktree (ignored files don't count), so removing it loses nothing. */
export async function worktreeClean(worktree: string) {
  const r = await run('git', ['status', '--porcelain'], { cwd: worktree });
  return r.code === 0 && r.stdout.trim() === '';
}

/** The branch holds commits or uncommitted changes that deleting it would lose. */
export function holdsWork(b: BranchWork) {
  return b.commits > 0 || b.dirty;
}

/**
 * Delete a task branch that holds no work: move the worktree off it (to the default branch, detached),
 * then delete the local branch and, if it was pushed, the remote one.
 */
export async function dropBranch(repoPath: string, worktree: string | null, defaultBranch: string, branch: string, b: BranchWork, env?: NodeJS.ProcessEnv, local = false) {
  if (holdsWork(b)) throw new Error(`${branch} holds work; not deleting it.`);
  if (b.checkedOut && worktree) await run('git', ['switch', '-q', '--detach', local ? defaultBranch : `origin/${defaultBranch}`], { cwd: worktree });
  if (b.local) await run('git', ['branch', '-D', branch], { cwd: repoPath });
  if (b.remote && !local) await run('git', ['push', '-q', 'origin', '--delete', branch], { cwd: repoPath, env, timeoutMs: 120_000 });
}

/** The files of a repository's working tree: tracked, and untracked ones git does not ignore. Paths use "/". */
export async function listFiles(repoPath: string, max: number): Promise<string[]> {
  const r = await run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: repoPath, timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().slice(0, 400) || 'git ls-files failed');
  return [...new Set(r.stdout.split('\0').filter(Boolean))].slice(0, max);
}
