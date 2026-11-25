import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, uid } from './util';
import { log } from './log';
import { CHECKPOINT_FORMAT, checkpointPrefix, checkpointsToDrop, parseCheckpoints, type Checkpoint } from '../shared/checkpoints';
import { t } from './i18n';

/** Commits are made without touching the user's git identity or hooks. */
const IDENT = ['-c', 'user.name=Oh My Agent IDE', '-c', 'user.email=checkpoints@oh-my-agent-ide.invalid'];

/** One at a time per worktree, so a save and a restore never work on the files together. */
const chains = new Map<string, Promise<unknown>>();
function inTurn<T>(dir: string, job: () => Promise<T>): Promise<T> {
  const next = (chains.get(dir) ?? Promise.resolve()).then(job, job);
  chains.set(dir, next.catch(() => undefined));
  return next;
}

export async function listCheckpoints(dir: string, workerId: string): Promise<Checkpoint[]> {
  if (!fs.existsSync(path.join(dir, '.git'))) return [];
  const r = await run('git', ['for-each-ref', '--sort=-creatordate', `--format=${CHECKPOINT_FORMAT}`, checkpointPrefix(workerId)], { cwd: dir });
  return r.code === 0 ? parseCheckpoints(r.stdout) : [];
}

/**
 * Save the worktree as it is now: every file git does not ignore, committed or not, as a commit held by a ref
 * of the Worker. The working tree, the index and the branch are not touched (the files are staged in a
 * throwaway index). Nothing is saved when it equals the last checkpoint. Returns the ref, or null.
 */
export function saveCheckpoint(dir: string, workerId: string, label: string): Promise<string | null> {
  return inTurn(dir, async () => {
    if (!fs.existsSync(path.join(dir, '.git'))) return null;
    const head = await run('git', ['rev-parse', '--verify', 'HEAD'], { cwd: dir });
    if (head.code !== 0) return null;
    const index = path.join(os.tmpdir(), `oma-index-${uid()}`);
    const env = { ...process.env, GIT_INDEX_FILE: index };
    try {
      for (const args of [['read-tree', 'HEAD'], ['add', '-A']]) {
        const r = await run('git', args, { cwd: dir, env, timeoutMs: 120_000 });
        if (r.code !== 0) { log.warn('checkpoint', args.join(' '), r.stderr.trim().slice(0, 200)); return null; }
      }
      const tree = (await run('git', ['write-tree'], { cwd: dir, env })).stdout.trim();
      if (!tree) return null;
      const before = await listCheckpoints(dir, workerId);
      if (before[0]?.tree === tree) return null;
      const commit = await run('git', [...IDENT, 'commit-tree', tree, '-p', head.stdout.trim(), '-m', label || 'Checkpoint'], { cwd: dir });
      if (commit.code !== 0) { log.warn('checkpoint commit-tree', commit.stderr.trim().slice(0, 200)); return null; }
      const ref = `${checkpointPrefix(workerId)}${Date.now()}`;
      const set = await run('git', ['update-ref', ref, commit.stdout.trim()], { cwd: dir });
      if (set.code !== 0) return null;
      for (const old of checkpointsToDrop([ref, ...before.map((c) => c.ref)])) await run('git', ['update-ref', '-d', old], { cwd: dir });
      return ref;
    } finally {
      fs.rm(index, { force: true }, () => undefined);
    }
  });
}

/**
 * Put the worktree's files back to a checkpoint. The state before is saved as a checkpoint first, so a restore
 * can itself be undone. The branch stays where it is: no commit is dropped and nothing is rewritten, so what was
 * pushed stays valid; the restored files show as changes against the branch's last commit.
 */
export async function restoreCheckpoint(dir: string, workerId: string, ref: string): Promise<void> {
  if (!ref.startsWith(checkpointPrefix(workerId)) || /[\s~^:?*[\\]|\.\./.test(ref)) throw new Error(t('ckpt.err.notMine'));
  const all = await listCheckpoints(dir, workerId);
  const target = all.find((c) => c.ref === ref);
  if (!target) throw new Error(t('ckpt.err.gone'));
  await saveCheckpoint(dir, workerId, `Before going back to: ${target.label}`.slice(0, 120));
  await inTurn(dir, async () => {
    const read = await run('git', ['read-tree', '-u', '--reset', target.tree], { cwd: dir, timeoutMs: 120_000 });
    if (read.code !== 0) throw new Error(read.stderr.trim().split('\n')[0] || t('ckpt.err.restore'));
    // Files made after the checkpoint and never committed are not in its tree; git leaves them, so they go here.
    // Ignored files (node_modules, .env) stay.
    const clean = await run('git', ['clean', '-fd'], { cwd: dir, timeoutMs: 120_000 });
    if (clean.code !== 0) log.warn('checkpoint clean', clean.stderr.trim().slice(0, 200));
  });
}
