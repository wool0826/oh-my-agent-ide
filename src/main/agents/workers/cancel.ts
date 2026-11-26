import fs from 'node:fs';
import path from 'node:path';
import { dropBranch, holdsWork, inspectBranch, worktreeClean } from '../../gitwork';
import { t } from '../../i18n';
import { log } from '../../log';
import { ghEnv } from '../../repos';
import { store } from '../../store';
import { nowIso } from '../../util';
import { taskStarted } from '../workerPrompt';
import type { WorkerManager } from '../workers';
import type { Key } from '../../../shared/i18n';
import { isLocalRepo } from '../../../shared/localRepo';
import { type CancelReport, type CancelWhy, cancelSet, describeCancel, isQueued, statusAfterCancel } from '../../../shared/queue';
import type { Task } from '../../../shared/types';
import { working } from './archive';
import { sendFeedback } from './messages';

/** Cancel one task that is waiting to start (queued or blocked), with the tasks waiting on it. */
export function cancelTask(m: WorkerManager, id: string, by: 'user' | 'dispatcher') {
  const task = store.task(id);
  if (!task) throw new Error(t('err.noTask', { id }));
  if (!isQueued(task) || inProgress(m, task)) throw new Error(t('err.notQueued', { id: task.id, status: t(`task.${task.status}` as Key) }));
  return cancel(m, [task.id], by, false);
}

/** Cancel every task waiting to start. Running work is left alone. */
export function clearQueue(m: WorkerManager, by: 'user' | 'dispatcher') {
  return cancel(m, store.data.tasks.filter((x) => isQueued(x) && !inProgress(m, x)).map((x) => x.id), by, true);
}

/** The task's turn is under way in its session: that is running work, which only Stop interrupts. */
export function inProgress(m: WorkerManager, task: Task) {
  const w = task.workerId ? store.worker(task.workerId) : null;
  return !!w && !!m.sessions.get(w.id)?.busy && m.currentTask(w)?.id === task.id;
}

export async function cancel(m: WorkerManager, ids: string[], by: 'user' | 'dispatcher', all: boolean): Promise<CancelReport[]> {
  // Every status changes before the first await, so a usage limit resetting meanwhile starts none of them.
  const reports = cancelNow(m, ids);
  if (!reports.length) return reports;
  announce(m, reports, all);
  store.changed();
  await tidyCancelled(m, reports);
  if (by === 'user') store.pushUpdate(`The user cancelled queued work: ${reports.map(describeCancel).join('; ')}`);
  // A Worker left with nothing open takes the PR feedback that waited for it (after the branches are tidied).
  sendFeedback(m);
  store.changed();
  return reports;
}

/**
 * Mark these tasks and the tasks waiting on them cancelled, at once. `after` and `why`: they were cancelled because
 * the task they waited for ended that way (failed, or its PR was closed).
 */
export function cancelNow(m: WorkerManager, ids: string[], after: string | null = null, why: CancelWhy | null = null): CancelReport[] {
  const { picked, followers } = cancelSet(store.data.tasks, ids);
  return [...picked.map((x) => markCancelled(m, x, after, why)), ...followers.map((x) => markCancelled(m, x, x.afterTaskId ?? null))];
}

/** Delete the branches cancelled tasks left and archive Workers left with nothing, then say what was kept. */
export async function tidyCancelled(m: WorkerManager, reports: CancelReport[]) {
  for (const r of reports) {
    try { await cleanUp(m, r); } catch (e) { log.warn(`cancel cleanup ${r.id}`, e); }
  }
  for (const id of new Set(reports.map((r) => r.workerId))) {
    if (!id || reports.some((r) => r.workerId === id && r.kept)) continue;
    try { await retireIfUnused(m, id); } catch (e) { log.warn(`cancel retire ${id}`, e); }
  }
  for (const r of reports) {
    if (!r.kept) continue;
    const vars = { title: r.title, branch: r.kept.branch, n: r.kept.commits, path: r.kept.path };
    store.event(t(r.kept.dirty ? 'ev.cancelKeptChanges' : 'ev.cancelKeptCommits', vars), { k: 'kept', task: r.id, worker: r.workerId ?? undefined, title: r.title, n: r.kept.commits, alt: !!r.kept.dirty });
  }
}

export function markCancelled(m: WorkerManager, task: Task, followerOf: string | null, why: CancelWhy | null = null): CancelReport {
  const wasQueued = task.status === 'queued';
  task.status = statusAfterCancel(task);
  task.queueReason = null;
  task.updatedAt = nowIso();
  m.reviewing.delete(task.id);
  m.ciFixing.delete(task.id);
  m.followups.delete(task.id);
  const w = task.workerId ? store.worker(task.workerId) : null;
  if (w) {
    if (wasQueued) {
      // Messages held for the paused work go with it, and the "until the limit resets" status too.
      m.held.delete(w.id);
      if (!w.taskIds.some((id) => store.task(id)?.status === 'queued')) w.statusText = '';
      // Its session may have started on it: tell it before it hears anything else.
      if (taskStarted(w, task) && task.status === 'cancelled') m.notes.set(w.id, [...(m.notes.get(w.id) ?? []), task.id]);
    }
    const after = why === 'closed' ? t('log.blockedCancelled') : why === 'failed' ? t('log.blockedFailed', { id: followerOf ?? '' }) : followerOf ? t('log.cancelledAfter', { id: followerOf }) : t('log.cancelled');
    store.log(w.id, 'event', task.status !== 'cancelled' ? t('log.queueDropped') : after);
  }
  return { id: task.id, title: task.title, workerId: w?.id ?? null, status: task.status, followerOf, kept: null };
}

export function announce(m: WorkerManager, reports: CancelReport[], all: boolean) {
  const part = (k: 'cancelled' | 'dropped', r: CancelReport) => ({ k, task: r.id, worker: r.workerId ?? undefined, title: r.title });
  const dropped = (r: CancelReport) => t(r.status === 'pr_open' ? 'ev.cancelDroppedPr' : 'ev.cancelDropped', { title: r.title });
  if (all) {
    store.event(t('ev.queueCleared', { n: reports.length }), { k: 'queueCleared', n: reports.length });
    for (const r of reports) if (r.status !== 'cancelled') store.event(dropped(r), part('dropped', r));
    return;
  }
  const [first, ...rest] = reports;
  store.event(first.status === 'cancelled' ? t('ev.cancelled', { title: first.title }) : dropped(first), part(first.status === 'cancelled' ? 'cancelled' : 'dropped', first));
  if (rest.length) store.event(t('ev.cancelFollowers', { n: rest.length, titles: rest.map((r) => `"${r.title}"`).join(', ') }), { k: 'followers', task: first.id, title: first.title, n: rest.length });
}

/** Delete the branch a cancelled task left, unless it holds commits or uncommitted changes. */
export async function cleanUp(m: WorkerManager, r: CancelReport) {
  const task = store.task(r.id);
  const w = r.workerId ? store.worker(r.workerId) : null;
  // Dropped review, CI or follow-up work keeps the task's branch and PR.
  if (!task || !w || task.status !== 'cancelled' || task.kind !== 'code' || !task.branch) return;
  const repo = task.repo ? store.repo(task.repo) : null;
  if (!repo || w.repo !== repo.name) return;
  const wt = fs.existsSync(path.join(w.cwd, '.git')) ? w.cwd : null;
  const b = await inspectBranch(repo.path, wt, repo.defaultBranch, task.branch, isLocalRepo(repo));
  if (holdsWork(b)) {
    r.kept = { branch: task.branch, commits: b.commits, dirty: b.dirty, path: wt ?? repo.path };
    store.log(w.id, 'event', t('log.cancelKept', { branch: task.branch }));
    return;
  }
  // A Worker busy in the worktree stays on its branch; that branch is the cancelled one only in odd states.
  if (b.checkedOut && working(m, w)) return;
  await dropBranch(repo.path, wt, repo.defaultBranch, task.branch, b, ghEnv(), isLocalRepo(repo));
}

/**
 * A Worker left with only cancelled tasks is archived, which removes its worktree, but only when nothing in it is uncommitted.
 * An archived Worker kept its worktree for a task waiting on a merge (archive()); once none is left, it goes.
 */
export async function retireIfUnused(m: WorkerManager, id: string) {
  const w = store.worker(id);
  if (!w || working(m, w)) return;
  const archived = w.status === 'archived';
  const hasWorktree = !!w.repo && fs.existsSync(path.join(w.cwd, '.git'));
  if (archived) {
    if (!hasWorktree || w.taskIds.some((x) => { const st = store.task(x)?.status; return st === 'pr_open' || st === 'blocked'; })) return;
  } else if (!w.taskIds.length || w.taskIds.some((x) => store.task(x)?.status !== 'cancelled')) return;
  if (hasWorktree && !(await worktreeClean(w.cwd))) return;
  await m.archive(w.id);
}
