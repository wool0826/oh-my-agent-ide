import { store } from './store';
import { workers } from './agents/workers';
import { cleanupBranch, ghEnv } from './repos';
import { notifyInfo } from './notify';
import { t } from './i18n';
import { run, nowIso } from './util';
import { log } from './log';
import { ask } from './decisions';
import { MAX_CI_FIXES, ciFixBody, failedLogTail, parseChecks, planCiFix, readiness, runsOf, type Check, type RollupItem } from './prchecks';
import type { Task } from '../shared/types';

/**
 * Watch open PRs.
 * - Merged or closed: delete the branch (local and remote), finish the task,
 *   notify, and start tasks that were waiting for this merge.
 * - Keep the merge readiness (CI, conflicts, review) on the task for the UI.
 * - New review comments, then failed CI: hand them to the Worker that opened the PR.
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
  asking.get(task.id)?.abort.abort(); // the CI question no longer applies
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

/** Hand new review comments to the Worker. True when some were sent. */
async function sendComments(task: Task) {
  const comments = await fetchComments(task);
  if (!comments) return false;
  const fresh = comments.filter((c) => !task.seenCommentIds.includes(c.id));
  if (!fresh.length) return false;
  task.seenCommentIds.push(...fresh.map((c) => c.id));
  task.reviewSyncedAt = nowIso();
  const body = fresh.map((c) => `- @${c.author} (${c.where}): ${c.body.trim()}`).join('\n');
  store.chat('event', t('ev.reviewing', { id: task.workerId ?? '', title: task.title, n: fresh.length }));
  workers.sendReview(task, body);
  return true;
}

/** Hand failed CI checks to the Worker: the end of each GitHub Actions log, or just the link for external CI. */
async function fixCi(task: Task, env: NodeJS.ProcessEnv, checks: Check[], headSha: string) {
  const plan = planCiFix(task, checks, headSha);
  if (!plan) return;
  const { failed } = plan;
  const logs = new Map<string, string | null>();
  for (const r of runsOf(failed).slice(0, 3)) {
    const out = await run('gh', ['run', 'view', r.id, '-R', r.repo, '--log-failed'], { env, timeoutMs: 120_000 });
    if (out.code !== 0) log.warn('run log failed', r.id, out.stderr.trim().slice(0, 200));
    logs.set(r.id, out.code === 0 ? failedLogTail(out.stdout) || null : null);
  }
  const body = ciFixBody(failed, logs);
  if (plan.action === 'ask') askAboutCi(task, body, failed.map((c) => c.name).join(', '));
  else sendCiFix(task, body);
  store.changed();
}

function sendCiFix(task: Task, body: string) {
  task.ciFixAttempts = (task.ciFixAttempts ?? 0) + 1;
  store.chat('event', t('ev.ciFixing', { id: task.workerId ?? '', title: task.title, n: task.ciFixAttempts, max: MAX_CI_FIXES }));
  workers.sendReview(task, body, 'ci');
}

/** Open CI decisions per task, with the latest failure to send if the user says to keep fixing. */
const asking = new Map<string, { body: string; abort: AbortController }>();

function askAboutCi(task: Task, body: string, names: string) {
  const open = asking.get(task.id);
  if (open) { open.body = body; return; }
  const entry = { body, abort: new AbortController() };
  asking.set(task.id, entry);
  const retry = t('ci.retry');
  const leave = t('ci.leave');
  store.pushUpdate(`${task.id} "${task.title}" CI still fails after ${MAX_CI_FIXES} automatic fixes (${names}); asked the user whether to keep fixing`);
  ask({
    source: 'question', workerId: task.workerId, taskId: task.id,
    title: t('ci.capTitle', { n: MAX_CI_FIXES }), detail: names, code: null,
    options: [{ label: retry, description: t('ci.retryDesc', { n: MAX_CI_FIXES }) }, { label: leave, description: t('ci.leaveDesc') }],
    questionKey: null,
  }, entry.abort.signal).then((ans) => {
    asking.delete(task.id);
    if (ans === leave || task.prState !== 'OPEN') return;
    task.ciFixAttempts = 0;
    sendCiFix(task, ans === retry ? entry.body : `${entry.body}\n\nThe user says: ${ans}`);
  }, () => asking.delete(task.id));
}

async function checkOne(task: Task) {
  const p = parsePr(task.prUrl!);
  if (!p) return;
  const env = { ...ghEnv(), GH_HOST: p.host };
  const r = await run('gh', ['pr', 'view', task.prUrl!, '--json', 'state,headRefName,headRefOid,mergeable,reviewDecision,statusCheckRollup'], { env, timeoutMs: 60_000 });
  if (r.code !== 0) {
    log.warn('pr view failed', task.prUrl, r.stderr.trim().slice(0, 200));
    return;
  }
  const j = JSON.parse(r.stdout) as {
    state: 'OPEN' | 'MERGED' | 'CLOSED'; headRefName: string; headRefOid?: string;
    mergeable?: string; reviewDecision?: string; statusCheckRollup?: RollupItem[];
  };
  if (j.state !== 'OPEN') return settle(task, j.state, j.headRefName);
  const checks = parseChecks(j.statusCheckRollup);
  const ready = readiness(checks, j.mergeable, j.reviewDecision);
  if (JSON.stringify(ready) !== JSON.stringify(task.prChecks ?? null)) {
    task.prChecks = ready;
    store.changed();
  }
  if (task.status !== 'pr_open') return; // the Worker is already on it
  if (await sendComments(task)) return;
  await fixCi(task, env, checks, j.headRefOid ?? '');
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
