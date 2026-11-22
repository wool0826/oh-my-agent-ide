import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { paths } from './paths';
import { loadSettings } from './settings';
import { store } from './store';
import { nowIso, run, runOk, slug, ensureDir, uid } from './util';
import { toolCommand } from './toolpath';
import { notFoundMessage } from '../shared/toolpath';
import { t } from './i18n';
import { log } from './log';
import type { Repo } from '../shared/types';
import { ghRepoRef, parseIssues, type Issue } from '../shared/issues';
import { baseRef, pickLocalDefault } from '../shared/localRepo';

/** Point gh at the company GitHub host via GH_HOST. */
export function ghEnv(): NodeJS.ProcessEnv {
  const host = loadSettings().githubHost.trim();
  return host ? { ...process.env, GH_HOST: host } : { ...process.env };
}

async function defaultBranch(dir: string) {
  const r = await addGit(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], dir);
  if (r.code === 0 && r.stdout.trim()) return r.stdout.trim().replace(/^origin\//, '');
  for (const b of ['main', 'master', 'develop']) {
    const x = await addGit(['rev-parse', '--verify', '-q', `refs/remotes/origin/${b}`], dir);
    if (x.code === 0) return b;
  }
  return 'main';
}

/** The default branch of a repository without a remote (see pickLocalDefault), or null when it has no commit yet. */
export async function localDefaultBranch(dir: string) {
  const current = (await addGit(['symbolic-ref', '--short', '-q', 'HEAD'], dir)).stdout.trim();
  const init = (await addGit(['config', '--get', 'init.defaultBranch'], dir)).stdout.trim();
  const list = await addGit(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], dir);
  return pickLocalDefault(current, init, list.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
}

/** Says when the repository being added makes progress (the window shows it). */
export const repoEvents = new EventEmitter();

/** The repository being added: one at a time. `abort` ends the git command it is running. */
let adding: { name: string; progress: string; child: ChildProcess | null; cancelled: boolean; abort: AbortController } | null = null;

/**
 * The environment for git while adding a repository: it never waits for an answer nobody can give (a password or
 * username prompt, Git Credential Manager's window, an SSH host-key question), so a missing credential fails at once.
 * Stored credentials still work.
 */
export function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...ghEnv(), GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
  if (!env.GIT_SSH_COMMAND) env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
  return env;
}

/** Say which step the add is on (the window shows it under the form). */
function step(text: string) {
  if (!adding || adding.progress === text) return;
  adding.progress = text;
  repoEvents.emit('progress');
}

/** git while adding: no prompt, a time limit, and ended by Cancel. */
function addGit(args: string[], cwd: string, timeoutMs = 60_000) {
  return run('git', args, { cwd, env: gitEnv(), timeoutMs, signal: adding?.abort.signal });
}

/** End a process and the ones it started (git clone runs git-remote-https; on Windows kill() ends only git). */
export function killTree(p: { pid?: number; kill(): unknown }) {
  if (process.platform === 'win32' && p.pid) {
    const k = spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    k.on('error', () => p.kill());
  } else p.kill();
}

/** What the window shows while a repository is added. */
export function addingRepo(): { name: string; progress: string } | null {
  return adding ? { name: adding.name, progress: adding.progress } : null;
}

/** Stop the clone under way. Its temporary folder is removed and nothing is registered. */
export function cancelAddRepo() {
  if (!adding) return false;
  adding.cancelled = true;
  adding.abort.abort();
  if (adding.child) killTree(adding.child);
  return true;
}

/** The last progress line git prints while cloning ("Receiving objects:  45% (…)"), without "remote: ". */
export function cloneProgress(chunk: string): string | null {
  const lines = chunk.split(/[\r\n]+/).map((l) => l.replace(/^remote:\s*/, '').trim()).filter((l) => /^(Cloning into|Enumerating|Counting|Compressing|Receiving|Resolving|Updating files)\b/.test(l));
  return lines.length ? lines[lines.length - 1].replace(/,\s*done\.$/, '').slice(0, 120) : null;
}

/** The parts of a child process that watchClone uses, so a test can hand it a stand-in. */
export interface CloneChild {
  pid?: number;
  stderr: NodeJS.EventEmitter | null;
  on(ev: 'error', fn: (e: Error) => void): unknown;
  on(ev: 'exit' | 'close', fn: (code: number | null) => void): unknown;
  kill(): unknown;
}

export interface CloneWatch {
  /** Ends the clone when git prints nothing for this long (a hung connection or a prompt nobody sees). */
  stallMs: number;
  /** Ends it after this long in all. */
  totalMs: number;
  cancelled: () => boolean;
  progress: (line: string) => void;
  kill: (p: CloneChild) => void;
}

/**
 * Settle a running git clone: resolves when it succeeds, rejects with a readable reason when it fails, cannot
 * start (git missing), makes no progress, takes too long or is cancelled. It settles once git has exited even when
 * a process it started still holds its output open, so the add never waits forever.
 */
export function watchClone(p: CloneChild, o: CloneWatch): Promise<void> {
  return new Promise((resolve, reject) => {
    let tail = '';
    let why: 'stall' | 'total' | null = null;
    let settled = false;
    let lingering: NodeJS.Timeout | null = null;
    const end = (e?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(total);
      clearTimeout(stall);
      if (lingering) clearTimeout(lingering);
      if (e) reject(e); else resolve();
    };
    const stop = (w: 'stall' | 'total') => { why = w; o.kill(p); };
    const total = setTimeout(() => stop('total'), o.totalMs);
    let stall = setTimeout(() => stop('stall'), o.stallMs);
    p.stderr?.on('data', (d: Buffer) => {
      const s = d.toString();
      tail = (tail + s).slice(-2000);
      clearTimeout(stall);
      stall = setTimeout(() => stop('stall'), o.stallMs);
      const line = cloneProgress(s);
      if (line) o.progress(line);
    });
    const finish = (code: number | null) => {
      if (o.cancelled()) return end(new Error(t('repo.err.cancelled')));
      if (why === 'total') return end(new Error(`git clone failed: it took more than ${Math.round(o.totalMs / 60_000)} minutes`));
      if (why === 'stall') return end(new Error(t('repo.err.stalled', { min: Math.max(1, Math.round(o.stallMs / 60_000)) })));
      if (code === 0) return end();
      const lines = tail.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
      const last = lines.filter((l) => /^(fatal|error|remote: error)/i.test(l)).pop() || lines.pop() || String(code);
      end(new Error(`git clone failed: ${last.slice(0, 400)}`));
    };
    p.on('error', (e) => {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return end(new Error(`git clone failed: ${e.message}`));
      // On macOS and Linux, where the app's PATH may lack the folder git is in, say which folders were searched.
      end(new Error(process.platform === 'win32' ? t('repo.err.noGit') : notFoundMessage('git', process.env.PATH ?? '')));
    });
    p.on('close', finish);
    // A helper git started can keep stderr open after git itself is gone: settle shortly after the exit anyway.
    p.on('exit', (code) => { if (!settled) lingering ??= setTimeout(() => finish(code), 2000); });
  });
}

/** git clone into `dir`, with progress for the window. Rejects when it fails, stalls, times out or is cancelled. */
function clone(url: string, dir: string): Promise<void> {
  const p = spawn(toolCommand('git'), ['clone', '--progress', url, dir], { env: gitEnv(), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  if (adding) adding.child = p;
  const job = adding;
  return watchClone(p, {
    stallMs: 3 * 60_000,
    totalMs: 30 * 60_000,
    cancelled: () => !!job?.cancelled,
    progress: (line) => step(line),
    kill: killTree,
  }).finally(() => { if (job) job.child = null; });
}

/** A folder a clone left behind; read-only pack files can need a retry on Windows. */
function removeDir(dir: string) {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { log.warn('remove folder', dir, e); }
}

/**
 * Register a repository. `url` is any git URL (https, ssh); "org/name" becomes a URL on the company GitHub host.
 * A clone goes to a temporary folder and takes its name only once it is complete, so a failed or cancelled one
 * leaves nothing a later add would take for a clone. A local folder is registered as it is: with an `origin` remote,
 * Workers start from `origin/<default branch>`; without one it is local only, and they start from its local default
 * branch, with no fetch, push or PR. It must be a git repository with at least one commit.
 */
export async function registerRepo(input: { url: string; name?: string; description?: string }): Promise<Repo> {
  let url = input.url.trim();
  const host = loadSettings().githubHost.trim();
  if (/^[\w.-]+\/[\w.-]+$/.test(url)) url = `https://${host || 'github.com'}/${url}.git`;
  const isLocal = fs.existsSync(url) && fs.statSync(url).isDirectory();
  const name = slug(input.name || path.basename(url).replace(/\.git$/, ''));
  if (store.repo(name)) throw new Error(t('repo.err.exists', { name }));
  if (adding) throw new Error(t('repo.err.adding', { name: adding.name }));
  const job = { name, progress: '', child: null, cancelled: false, abort: new AbortController() };
  adding = job;
  repoEvents.emit('progress');
  try {
    let dir: string;
    let local = false;
    if (isLocal) {
      dir = path.resolve(url);
      step(t('repo.step.check'));
      const top = await addGit(['rev-parse', '--git-dir'], dir);
      if (top.code !== 0) throw new Error(t(/ENOENT/.test(top.stderr) ? 'repo.err.noGit' : 'repo.err.notGit'));
      const origin = await addGit(['remote', 'get-url', 'origin'], dir);
      if (origin.code === 0 && origin.stdout.trim()) url = origin.stdout.trim();
      else {
        local = true;
        url = dir;
      }
    } else {
      ensureDir(paths().repos);
      dir = path.join(paths().repos, name);
      if (fs.existsSync(dir)) {
        // A clone kept from when this repository was registered before: used again only when it is one of this URL.
        const origin = await addGit(['remote', 'get-url', 'origin'], dir);
        if (origin.code !== 0 || origin.stdout.trim() !== url) throw new Error(t('repo.err.folder', { path: dir }));
      } else {
        const tmp = path.join(paths().repos, `.${name}.adding-${uid()}`);
        step(t('repo.step.clone'));
        try {
          await clone(url, tmp);
          fs.renameSync(tmp, dir);
        } catch (e) {
          removeDir(tmp);
          throw e;
        }
      }
    }
    if (job.cancelled) throw new Error(t('repo.err.cancelled'));
    let branch: string;
    if (local) {
      // Nothing here reaches a remote: there is none.
      const b = await localDefaultBranch(dir);
      if (!b) throw new Error(t('repo.err.noCommit'));
      branch = b;
    } else {
      step(t('repo.step.fetch'));
      // A fetch that fails (offline, no access) still lets a fresh clone through; a stale checkout is checked below.
      await addGit(['fetch', '-q', 'origin'], dir, 5 * 60_000);
      if (job.cancelled) throw new Error(t('repo.err.cancelled'));
      step(t('repo.step.check'));
      branch = await defaultBranch(dir);
      const has = await addGit(['rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}`], dir);
      if (has.code !== 0) throw new Error(t('repo.err.noBranch', { branch }));
    }
    if (job.cancelled) throw new Error(t('repo.err.cancelled'));
    const repo: Repo = {
      name, url, path: dir,
      description: input.description?.trim() || '',
      defaultBranch: branch,
      addedAt: nowIso(),
      ...(local ? { local: true } : {}),
    };
    store.data.repos.push(repo);
    store.changed();
    return repo;
  } finally {
    adding = null;
    repoEvents.emit('progress');
  }
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
  // A local-only repository has nothing to fetch: the worktree starts from its own default branch.
  if (!repo.local) await run('git', ['fetch', '-q', 'origin'], { cwd: repo.path, env: gitEnv(), timeoutMs: 5 * 60_000 });
  await runOk('git', ['worktree', 'add', '--detach', dir, baseRef(repo)], { cwd: repo.path });
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

/**
 * After a PR is merged or closed: move the worktree back to the default branch and delete the local and remote branch.
 * A local-only repository has no PR, so this never runs for one; if it did, its branch is kept (it is the only copy).
 */
export async function cleanupBranch(repo: Repo, worktree: string | null, branch: string) {
  if (repo.local) return;
  if (worktree && fs.existsSync(worktree)) {
    await run('git', ['fetch', '-q', 'origin'], { cwd: worktree, env: gitEnv() });
    const cur = await run('git', ['branch', '--show-current'], { cwd: worktree });
    if (cur.stdout.trim() === branch) await run('git', ['switch', '--detach', `origin/${repo.defaultBranch}`], { cwd: worktree });
  }
  await run('git', ['branch', '-D', branch], { cwd: repo.path });
  await run('git', ['push', 'origin', '--delete', branch], { cwd: repo.path, env: ghEnv(), timeoutMs: 120_000 });
}
