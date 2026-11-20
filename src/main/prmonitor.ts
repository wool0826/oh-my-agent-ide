import { store } from './store';
import { workers } from './agents/workers';
import { cleanupBranch, ghEnv } from './repos';
import { notifyInfo } from './notify';
import { t } from './i18n';
import { run, nowIso } from './util';
import { log } from './log';
import type { Task } from '../shared/types';

/**
 * Watch open PRs.
 * - Merged or closed: delete the branch (local and remote), finish the task,
 *   notify, and start tasks that were waiting for this merge.
 * - New review comments: hand them to the Worker that opened the PR.
 */

function parsePr(url: string) {
  const m = url.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  return m ? { host: m[1], owner: m[2], repo: m[3], num: m[4] } : null;
}

interface Comment { id: string; author: string; body: string; where: string }

async function fetchComments(task: Task): Promise<Comment[] | null> {
  const p = parsePr(task.prUrl!);
  if (!p) return null;
  const env = { ...ghEnv(), GH_HOST: p.host };
  const out: Comment[] = [];
  const view = await run('gh', ['pr', 'view', task.prUrl!, '--json', 'comments,reviews'], { env, timeoutMs: 60_000 });
  if (view.code !== 0) return null;
  const j = JSON.parse(view.stdout);
  for (const c of j.comments ?? []) out.push({ id: `c:${c.id}`, author: c.author?.login ?? '?', body: c.body ?? '', where: 'conversation' });
  for (const r of j.reviews ?? []) if (r.body?.trim()) out.push({ id: `r:${r.id}`, author: r.author?.login ?? '?', body: r.body, where: `review (${r.state})` });
  const inline = await run('gh', ['api', `repos/${p.owner}/${p.repo}/pulls/${p.num}/comments`, '--paginate'], { env, timeoutMs: 60_000 });
  if (inline.code === 0) {
    try {
      for (const c of JSON.parse(inline.stdout)) out.push({ id: `i:${c.id}`, author: c.user?.login ?? '?', body: c.body ?? '', where: `${c.path}:${c.line ?? c.original_line ?? ''}` });
    } catch { /* several pages arrive as concatenated JSON arrays; use what parsed */ }
  }
  return out.filter((c) => !/\[bot\]$/.test(c.author));
}

async function settle(task: Task, state: 'MERGED' | 'CLOSED', headRef: string) {
  const merged = state === 'MERGED';
  task.prState = state;
  task.status = 'done';
  task.updatedAt = nowIso();
  if (merged) task.mergedAt = nowIso();
  const repo = task.repo ? store.repo(task.repo) : null;
  const w = task.workerId ? store.worker(task.workerId) : null;
  const branch = task.branch ?? headRef;
  if (repo && branch) await cleanupBranch(repo, w?.repo === repo.name ? w.cwd : null, branch).catch((e) => log.warn('cleanup', e));
  const text = merged ? t('ev.prMerged', { title: task.title }) : t('ev.prClosed', { title: task.title });
  store.chat('event', text);
  if (w) store.log(w.id, 'event', text);
  store.pushUpdate(`${task.id} "${task.title}" PR ${merged ? 'merged' : 'closed without merging'}; branch cleaned up`);
  notifyInfo(merged ? t('noti.merged') : t('noti.closed'), task.title);
  workers.onPrSettled(task, merged);
  store.changed();
}

async function checkOne(task: Task) {
  const p = parsePr(task.prUrl!);
  if (!p) return;
  const env = { ...ghEnv(), GH_HOST: p.host };
  const r = await run('gh', ['pr', 'view', task.prUrl!, '--json', 'state,headRefName'], { env, timeoutMs: 60_000 });
  if (r.code !== 0) {
    log.warn('pr view failed', task.prUrl, r.stderr.trim().slice(0, 200));
    return;
  }
  const j = JSON.parse(r.stdout) as { state: 'OPEN' | 'MERGED' | 'CLOSED'; headRefName: string };
  if (j.state !== 'OPEN') return settle(task, j.state, j.headRefName);
  if (task.status !== 'pr_open') return; // already addressing comments
  const comments = await fetchComments(task);
  if (!comments) return;
  const fresh = comments.filter((c) => !task.seenCommentIds.includes(c.id));
  if (!fresh.length) return;
  task.seenCommentIds.push(...fresh.map((c) => c.id));
  task.reviewSyncedAt = nowIso();
  const body = fresh.map((c) => `- @${c.author} (${c.where}): ${c.body.trim()}`).join('\n');
  store.chat('event', t('ev.reviewing', { id: task.workerId ?? '', title: task.title, n: fresh.length }));
  workers.sendReview(task, body);
}

let running = false;
let lastRun = 0;
export async function checkPrs() {
  if (running) return;
  running = true;
  lastRun = Date.now();
  try {
    for (const task of store.data.tasks) {
      if (!task.prUrl || task.prState === 'MERGED' || task.prState === 'CLOSED') continue;
      // While a Worker is fixing review comments the task is "running"; still notice a merge.
      if (task.status !== 'pr_open' && task.status !== 'running') continue;
      try { await checkOne(task); } catch (e) { log.warn('pr check', task.prUrl, (e as Error).message); }
    }
  } finally {
    running = false;
  }
}

/** Check soon when the window comes back to the front, at most once a minute. */
export function checkPrsSoon() {
  if (Date.now() - lastRun > 60_000) void checkPrs();
}

export function startPrMonitor() {
  setTimeout(() => void checkPrs(), 20_000).unref();
  setInterval(() => void checkPrs(), 3 * 60_000).unref();
}
