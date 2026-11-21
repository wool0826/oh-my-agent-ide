import fs from 'node:fs';
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

/** Read what the branch of a cancelled task holds, so nothing with work in it is deleted. */
export async function inspectBranch(repoPath: string, worktree: string | null, defaultBranch: string, branch: string): Promise<BranchWork> {
  const base = `refs/remotes/origin/${defaultBranch}`;
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
export async function dropBranch(repoPath: string, worktree: string | null, defaultBranch: string, branch: string, b: BranchWork, env?: NodeJS.ProcessEnv) {
  if (holdsWork(b)) throw new Error(`${branch} holds work; not deleting it.`);
  if (b.checkedOut && worktree) await run('git', ['switch', '-q', '--detach', `origin/${defaultBranch}`], { cwd: worktree });
  if (b.local) await run('git', ['branch', '-D', branch], { cwd: repoPath });
  if (b.remote) await run('git', ['push', '-q', 'origin', '--delete', branch], { cwd: repoPath, env, timeoutMs: 120_000 });
}
