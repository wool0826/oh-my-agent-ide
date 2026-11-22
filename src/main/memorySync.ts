import fs from 'node:fs';
import path from 'node:path';
import { run, type RunResult } from './util';

/**
 * Two-way sync of the memory folder with its remote: fetch, merge what the remote has, push what it lacks.
 * A push alone is rejected for good once the remote holds a commit this folder does not (a second PC, or a
 * repository created with a README), so every sync merges first.
 */

export interface SyncResult {
  ok: boolean;
  /** One line from git, when a step failed. */
  error: string | null;
  /** Commits merged in from the remote, and commits sent to it. */
  pulled: number;
  pushed: number;
  /** Commits here that the remote still lacks (after a failed sync). */
  pending: number;
}

const GIT_ID = ['-c', 'user.name=Oh My Agent IDE', '-c', 'user.email=ide@localhost'];
/** Memory files are lists that both sides append to: keep the lines of both instead of stopping on a conflict. */
const ATTRIBUTES = '*.md merge=union\n';
const NET_TIMEOUT = 60_000;

/** git never stops to ask for a password: without stored credentials it fails, and the failure is shown. */
const git = (cwd: string, args: string[], timeoutMs?: number): Promise<RunResult> =>
  run('git', args, { cwd, timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });

const firstLine = (r: RunResult) => (r.stderr || r.stdout).split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 2).join(' ').slice(0, 300) || `git exited with ${r.code}`;
const count = async (cwd: string, range: string) => Number((await git(cwd, ['rev-list', '--count', range])).stdout.trim()) || 0;

/** Commit whatever changed in the folder. True when a commit was made. */
export async function commitAll(cwd: string, message: string): Promise<boolean> {
  await git(cwd, ['add', '-A']);
  if (!(await git(cwd, ['status', '--porcelain'])).stdout.trim()) return false;
  return (await git(cwd, [...GIT_ID, 'commit', '-q', '-m', message])).code === 0;
}

async function ensureAttributes(cwd: string) {
  const f = path.join(cwd, '.gitattributes');
  const has = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  if (has.includes('merge=union')) return;
  fs.writeFileSync(f, has + (has && !has.endsWith('\n') ? '\n' : '') + ATTRIBUTES, 'utf8');
  await commitAll(cwd, 'Merge memory files line by line');
}

/** The remote branch to sync with: this folder's own, else the remote's default, else the usual names. */
async function remoteBranch(cwd: string, local: string): Promise<{ name: string; exists: boolean }> {
  const refs = (await git(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin'])).stdout
    .split('\n').map((l) => l.trim()).filter((l) => l.startsWith('origin/') && l !== 'origin/HEAD').map((l) => l.slice(7));
  if (!refs.length) return { name: local, exists: false };
  if (refs.includes(local)) return { name: local, exists: true };
  const head = (await git(cwd, ['ls-remote', '--symref', 'origin', 'HEAD'], NET_TIMEOUT)).stdout.match(/^ref: refs\/heads\/(\S+)\s+HEAD/m)?.[1];
  const name = (head && refs.includes(head) ? head : null) ?? ['main', 'master'].find((b) => refs.includes(b)) ?? refs[0];
  return { name, exists: true };
}

export async function syncRepo(cwd: string, remote: string): Promise<SyncResult> {
  const res: SyncResult = { ok: false, error: null, pulled: 0, pushed: 0, pending: 0 };
  const fail = async (r: RunResult, target?: string) => {
    res.error = firstLine(r);
    res.pending = target ? await count(cwd, `${target}..HEAD`) : await count(cwd, 'HEAD');
    return res;
  };

  const url = await git(cwd, ['remote', 'get-url', 'origin']);
  if (url.code !== 0) await git(cwd, ['remote', 'add', 'origin', remote]);
  else if (url.stdout.trim() !== remote) {
    await git(cwd, ['remote', 'set-url', 'origin', remote]);
    // Branches fetched from the old address say nothing about the new one.
    await git(cwd, ['remote', 'prune', 'origin'], NET_TIMEOUT);
  }
  await ensureAttributes(cwd);

  const fetched = await git(cwd, ['fetch', '-q', '--prune', 'origin'], NET_TIMEOUT);
  if (fetched.code !== 0) return fail(fetched);

  const local = (await git(cwd, ['branch', '--show-current'])).stdout.trim() || 'main';
  const target = await remoteBranch(cwd, local);
  const ref = `origin/${target.name}`;

  if (target.exists) {
    res.pulled = await count(cwd, `HEAD..${ref}`);
    if (res.pulled > 0) {
      const related = (await git(cwd, ['merge-base', 'HEAD', ref])).code === 0;
      const merged = await git(cwd, [...GIT_ID, 'merge', '-q', '--no-edit', ...(related ? [] : ['--allow-unrelated-histories']), ref]);
      if (merged.code !== 0) {
        await git(cwd, ['merge', '--abort']);
        res.pulled = 0;
        return fail(merged, ref);
      }
    }
  }

  res.pushed = target.exists ? await count(cwd, `${ref}..HEAD`) : await count(cwd, 'HEAD');
  if (res.pushed > 0) {
    const pushed = await git(cwd, ['push', '-q', '-u', 'origin', `HEAD:refs/heads/${target.name}`], NET_TIMEOUT);
    if (pushed.code !== 0) {
      res.pending = res.pushed;
      res.pushed = 0;
      res.error = firstLine(pushed);
      return res;
    }
  }
  res.ok = true;
  return res;
}
