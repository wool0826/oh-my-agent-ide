import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { paths } from './paths';
import { loadSettings } from './settings';
import { store } from './store';
import { nowIso, run, runOk, slug, ensureDir } from './util';
import { t } from './i18n';
import { log } from './log';
import type { Repo } from '../shared/types';
import { ghRepoRef, parseIssues, type Issue } from '../shared/issues';

/** Point gh at the company GitHub host via GH_HOST. */
export function ghEnv(): NodeJS.ProcessEnv {
  const host = loadSettings().githubHost.trim();
  return host ? { ...process.env, GH_HOST: host } : { ...process.env };
}

async function defaultBranch(dir: string) {
  const r = await run('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: dir });
  if (r.code === 0 && r.stdout.trim()) return r.stdout.trim().replace(/^origin\//, '');
  for (const b of ['main', 'master', 'develop']) {
    const x = await run('git', ['rev-parse', '--verify', '-q', `refs/remotes/origin/${b}`], { cwd: dir });
    if (x.code === 0) return b;
  }
  return 'main';
}

/**
 * Register a repository. `url` is any git URL (https, ssh); "org/name" becomes a URL on the company GitHub host.
 * An existing local folder is registered without cloning.
 */
export async function registerRepo(input: { url: string; name?: string; description?: string }): Promise<Repo> {
  let url = input.url.trim();
  const host = loadSettings().githubHost.trim();
  if (/^[\w.-]+\/[\w.-]+$/.test(url)) url = `https://${host || 'github.com'}/${url}.git`;
  const isLocal = fs.existsSync(url) && fs.statSync(url).isDirectory();
  const name = slug(input.name || path.basename(url).replace(/\.git$/, ''));
  if (store.repo(name)) throw new Error(t('repo.err.exists', { name }));
  let dir: string;
  if (isLocal) {
    dir = path.resolve(url);
    await runOk('git', ['rev-parse', '--git-dir'], { cwd: dir });
    const origin = await run('git', ['remote', 'get-url', 'origin'], { cwd: dir });
    if (origin.code === 0) url = origin.stdout.trim();
  } else {
    ensureDir(paths().repos);
    dir = path.join(paths().repos, name);
    if (!fs.existsSync(dir)) await runOk('git', ['clone', url, dir], { env: ghEnv(), timeoutMs: 30 * 60_000 });
  }
  await run('git', ['fetch', '-q', 'origin'], { cwd: dir, timeoutMs: 5 * 60_000 });
  const repo: Repo = {
    name, url, path: dir,
    description: input.description?.trim() || '',
    defaultBranch: await defaultBranch(dir),
    addedAt: nowIso(),
  };
  store.data.repos.push(repo);
  store.changed();
  return repo;
}

export function removeRepo(name: string) {
  store.data.repos = store.data.repos.filter((r) => r.name !== name);
  store.changed();
}

/** A repository's open issues, the most recently updated first. Null when it is not on GitHub (a local folder). */
export async function listIssues(name: string): Promise<Issue[] | null> {
  const repo = store.repo(name);
  const ref = repo ? ghRepoRef(repo.url) : null;
  if (!ref) return null;
  const r = await run('gh', ['issue', 'list', '-R', `${ref.host}/${ref.slug}`, '--state', 'open', '--limit', '50', '--json', 'number,title,url,labels,updatedAt'], { env: { ...ghEnv(), GH_HOST: ref.host }, timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error(r.stderr.trim().split('\n')[0] || t('issue.err'));
  return parseIssues(r.stdout);
}

export function updateRepo(name: string, patch: Partial<Pick<Repo, 'description' | 'setup' | 'run'>>) {
  const r = store.repo(name);
  if (!r) return;
  Object.assign(r, patch);
  store.changed();
}

/** One worktree per Worker per repo. The Worker creates a new branch for each task. */
export async function ensureWorktree(repo: Repo, workerId: string): Promise<string> {
  const dir = path.join(paths().worktrees, repo.name, workerId);
  if (fs.existsSync(path.join(dir, '.git'))) return dir;
  ensureDir(path.dirname(dir));
  await run('git', ['fetch', '-q', 'origin'], { cwd: repo.path, timeoutMs: 5 * 60_000 });
  await runOk('git', ['worktree', 'add', '--detach', dir, `origin/${repo.defaultBranch}`], { cwd: repo.path });
  if (repo.setup?.trim()) {
    const r = await runSetup(repo.setup, dir, repo.path);
    if (r.code !== 0) store.chat('error', t('ev.setupFailed', { repo: repo.name, msg: r.tail || String(r.code) }));
  }
  return dir;
}

/**
 * Run a repository's setup command in a new worktree through the platform shell.
 * ROOT_PATH is the main checkout, so `cp "$ROOT_PATH/.env" .` works.
 */
export function runSetup(cmd: string, cwd: string, root: string): Promise<{ code: number; tail: string }> {
  return new Promise((resolve) => {
    const win = process.platform === 'win32';
    const p = spawn(win ? 'powershell.exe' : (process.env.SHELL || '/bin/sh'), win ? ['-NoProfile', '-NonInteractive', '-Command', cmd] : ['-lc', cmd], {
      cwd, env: { ...ghEnv(), ROOT_PATH: root, OMA_ROOT_PATH: root }, windowsHide: true,
    });
    let out = '';
    const keep = (d: Buffer) => { out = (out + d.toString()).slice(-4000); };
    p.stdout.on('data', keep);
    p.stderr.on('data', keep);
    const timer = setTimeout(() => p.kill(), 20 * 60_000);
    let finished = false;
    const done = (code: number) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      log[code === 0 ? 'info' : 'warn'](`setup in ${cwd} exited ${code}`, out.slice(-800));
      resolve({ code, tail: out.trim().split('\n').slice(-3).join(' ').slice(0, 300) });
    };
    p.on('error', (e) => { out += e.message; done(1); });
    p.on('close', (c) => done(c ?? 1));
  });
}

export async function removeWorktree(repo: Repo, dir: string) {
  await run('git', ['worktree', 'remove', '--force', dir], { cwd: repo.path });
  await run('git', ['worktree', 'prune'], { cwd: repo.path });
}

/** After a PR is merged or closed: move the worktree back to the default branch and delete the local and remote branch. */
export async function cleanupBranch(repo: Repo, worktree: string | null, branch: string) {
  if (worktree && fs.existsSync(worktree)) {
    await run('git', ['fetch', '-q', 'origin'], { cwd: worktree });
    const cur = await run('git', ['branch', '--show-current'], { cwd: worktree });
    if (cur.stdout.trim() === branch) await run('git', ['switch', '--detach', `origin/${repo.defaultBranch}`], { cwd: worktree });
  }
  await run('git', ['branch', '-D', branch], { cwd: repo.path });
  await run('git', ['push', 'origin', '--delete', branch], { cwd: repo.path, env: ghEnv(), timeoutMs: 120_000 });
}
