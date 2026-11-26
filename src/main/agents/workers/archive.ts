import fs from 'node:fs';
import path from 'node:path';
import { worktreeClean } from '../../gitwork';
import { t } from '../../i18n';
import { log } from '../../log';
import { ensureWorktree, removeWorktree } from '../../repos';
import { loadSettings } from '../../settings';
import { store } from '../../store';
import { ensureDir, oneLine } from '../../util';
import type { WorkerManager } from '../workers';
import { holdsWorktree, isQueued } from '../../../shared/queue';
import type { Worker } from '../../../shared/types';

/** The Worker is using its worktree (see working()). */
export function inUse(m: WorkerManager, workerId: string) {
  const w = store.worker(workerId);
  return !!w && working(m, w);
}

/** The Worker is using its worktree: mid-turn, or one of its tasks is running. */
export function working(m: WorkerManager, w: Worker) {
  return !!m.sessions.get(w.id)?.busy
    || w.taskIds.some((id) => { const x = store.task(id); return x?.status === 'running' || x?.status === 'waiting'; });
}

/**
 * Close a Worker's session and remove its worktree. A Worker at work is refused: its task would be left running
 * with nobody on it (Stop it first). The folder stays while a task still needs it (a PR, a queued or blocked task)
 * or while it holds uncommitted changes, which removing it would lose. Says which folder was kept and why.
 */
export async function archive(m: WorkerManager, workerId: string): Promise<{ kept: 'task' | 'dirty' | null }> {
  const w = store.worker(workerId);
  if (!w) return { kept: null };
  m.checkArchive(w.id);
  m.sessions.get(w.id)?.close();
  m.sessions.delete(w.id);
  m.said.delete(w.id);
  w.status = 'archived';
  w.statusText = '';
  let kept: 'task' | 'dirty' | null = w.taskIds.some((id) => holdsWorktree(store.task(id))) ? 'task' : null;
  const repo = w.repo ? store.repo(w.repo) : null;
  if (repo && !kept && fs.existsSync(w.cwd)) {
    if (fs.existsSync(path.join(w.cwd, '.git')) && !(await worktreeClean(w.cwd))) {
      kept = 'dirty';
      store.log(w.id, 'event', t('log.archiveKeptDirty'));
    } else await removeWorktree(repo, w.cwd).catch(() => {});
  }
  store.changed();
  return { kept };
}

/** Throws while the Worker is at work: archiving it would leave its task running with nobody on it. */
export function checkArchive(m: WorkerManager, workerId: string) {
  const w = store.worker(workerId);
  if (w && working(m, w)) throw new Error(t('err.archiveBusy', { id: w.id }));
}

/** Throws when the repository can't be removed yet: one of its tasks is open, or one of its Workers is mid-turn. */
export function checkRetire(m: WorkerManager, name: string) {
  const open = store.data.tasks.filter((x) => x.repo === name && (x.status === 'running' || x.status === 'waiting' || isQueued(x)));
  if (open.length) throw new Error(t('repo.err.busy', { ids: open.map((x) => x.id).join(', ') }));
  const busy = store.data.workers.find((w) => w.repo === name && working(m, w));
  if (busy) throw new Error(t('err.archiveBusy', { id: busy.id }));
}

/**
 * Before a repository is removed: refused while one of its tasks is open (running, waiting, queued or blocked),
 * since nothing could finish it. Its Workers are archived and their worktrees removed, also one kept for an open
 * PR, which nothing follows any more. A worktree with uncommitted changes is kept. Returns the Workers whose was.
 */
export async function retireRepo(m: WorkerManager, name: string): Promise<string[]> {
  m.checkRetire(name);
  const repo = store.repo(name);
  const ws = store.data.workers.filter((w) => w.repo === name);
  const kept: string[] = [];
  for (const w of ws) {
    if (w.status !== 'archived') await m.archive(w.id);
    if (!repo || !fs.existsSync(path.join(w.cwd, '.git'))) continue;
    if (await worktreeClean(w.cwd)) await removeWorktree(repo, w.cwd).catch(() => {});
    else kept.push(w.id);
  }
  return kept;
}

/** Bring an archived Worker back, its worktree first. Rejects when that fails; the Worker stays archived. */
export function unarchive(m: WorkerManager, w: Worker): Promise<void> {
  const busy = m.unarchiving.get(w.id);
  if (busy) return busy;
  const run = (async () => {
    const repo = w.repo ? store.repo(w.repo) : null;
    if (repo && !fs.existsSync(path.join(w.cwd, '.git'))) await ensureWorktree(repo, w.id);
    if (!repo) ensureDir(w.cwd);
    // Not over a status the Worker got meanwhile.
    if (w.status === 'archived') w.status = 'idle';
    m.touch(w);
  })().finally(() => m.unarchiving.delete(w.id));
  m.unarchiving.set(w.id, run);
  return run;
}

/** unarchive() for work the app hands on by itself: null, or why it failed (also said in the Worker's conversation). */
export async function restoreWorker(m: WorkerManager, w: Worker): Promise<string | null> {
  try {
    await m.unarchive(w);
    return null;
  } catch (e) {
    const msg = oneLine((e as Error).message ?? String(e), 200);
    log.warn(`unarchive ${w.id} failed`, msg);
    const why = t('log.unarchiveFailed', { msg });
    store.log(w.id, 'event', why);
    store.changed();
    return why;
  }
}

/** Archive Workers idle for longer than the setting (0 = never). One with an open task is left alone; archive() keeps uncommitted work. */
export function autoArchive(m: WorkerManager) {
  const days = loadSettings().archiveDays;
  if (!(days > 0)) return;
  const cutoff = Date.now() - days * 24 * 3600_000;
  for (const w of store.data.workers) {
    if (w.status !== 'idle' && w.status !== 'error') continue;
    if (Date.parse(w.lastActiveAt) > cutoff) continue;
    if (working(m, w) || w.taskIds.some((id) => holdsWorktree(store.task(id)))) continue;
    log.info(`auto-archive ${w.id}`);
    m.archive(w.id).catch((e) => log.warn(`auto-archive ${w.id}`, e));
  }
}
