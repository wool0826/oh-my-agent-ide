import { store } from './store';
import { workers } from './agents/workers';
import { cleanupBranch, ghEnv } from './repos';
import { notifyInfo } from './notify';
import { t } from './i18n';
import { run, nowIso } from './util';
import { log } from './log';
import { automations } from './automations';
import { ask } from './decisions';
import { MAX_CI_FIXES, ciFixBody, failedLogTail, parseChecks, planCiFix, readiness, runsOf, type Check, type RollupItem } from './prchecks';
import { adoptSeen, prBusy, prsToWatch, type PrWatch } from '../shared/prs';
import { ciReason } from '../shared/askWhy';
import { canMerge, conflictBody, mergeMethod, planConflictFix } from '../shared/prMerge';
import type { Task } from '../shared/types';

/**
 * Watch open PRs.
 * - Merged or closed: delete the branch (local and remote), finish the task,
 *   notify, and start tasks that were waiting for this merge.
 * - Keep the merge readiness (CI, conflicts, review) on the task for the UI.
 * - New review comments, then a conflict with the base, then failed CI: hand them to the Worker that opened the PR.
 * - Each PR once, even when a follow-up task pushed to its branch and recorded the same URL.
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

/**
 * The PR was merged or closed: finish the tasks in review or being fixed, clean up each branch once, and announce it once.
 * Every other task that recorded the PR (failed or cancelled later work, for one) gets the PR's state too.
 */
export async function settle(watch: PrWatch<Task>, state: 'MERGED' | 'CLOSED', headRef: string) {
  const merged = state === 'MERGED';
  const { tasks } = watch;
  const first = tasks[0];
  const settling = watch.all.filter((x) => x.prState !== 'MERGED' && x.prState !== 'CLOSED');
  // Automations waiting for a merge hear of it once per PR: only while some task still has it as open.
  if (merged && settling.length) automations.onMerged(first);
  for (const task of settling) {
    asking.get(task.id)?.abort.abort(); // the CI question no longer applies
    task.prState = state;
    task.updatedAt = nowIso();
    if (merged) task.mergedAt = nowIso();
    if (tasks.includes(task)) task.status = 'done';
  }
  // The PR's branch, plus a follow-up's own branch if it made one before pushing to the PR's.
  const cleaned = new Set<string>();
  for (const task of tasks) {
    const repo = task.repo ? store.repo(task.repo) : null;
    const branch = task.branch ?? headRef;
    if (!repo || !branch || cleaned.has(branch)) continue;
    cleaned.add(branch);
    const w = task.workerId ? store.worker(task.workerId) : null;
    await cleanupBranch(repo, w?.repo === repo.name ? w.cwd : null, branch).catch((e) => log.warn('cleanup', e));
  }
  if (!watch.announced) {
    const text = merged ? t('ev.prMerged', { title: first.title }) : t('ev.prClosed', { title: first.title });
    store.chat('event', text);
    for (const id of new Set(tasks.map((x) => x.workerId))) if (id && store.worker(id)) store.log(id, 'event', text);
    const also = tasks.length > 1 ? ` (also recorded by ${tasks.slice(1).map((x) => x.id).join(', ')})` : '';
    store.pushUpdate(`${first.id} "${first.title}" PR ${merged ? 'merged' : 'closed without merging'}${also}; branch cleaned up`);
    notifyInfo(merged ? t('noti.merged') : t('noti.closed'), first.title);
  }
  // Tasks waiting (after_task_id) on any of them start, or are cancelled if the PR was closed.
  for (const task of settling) workers.onPrSettled(task, merged);
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
    reason: ciReason(t, { who: task.workerId ?? 'Worker', task, prNum: task.prUrl?.match(/\/pull\/(\d+)/)?.[1] ?? '?', fixes: MAX_CI_FIXES, names }),
  }, entry.abort.signal).then((ans) => {
    asking.delete(task.id);
    if (ans === leave || task.prState !== 'OPEN') return;
    task.ciFixAttempts = 0;
    sendCiFix(task, ans === retry ? entry.body : `${entry.body}\n\nThe user says: ${ans}`);
  }, () => asking.delete(task.id));
}

async function checkOne(watch: PrWatch<Task>) {
  const task = watch.tasks[0];
  const p = parsePr(task.prUrl!);
  if (!p) return;
  const env = { ...ghEnv(), GH_HOST: p.host };
  const r = await run('gh', ['pr', 'view', task.prUrl!, '--json', 'state,headRefName,headRefOid,baseRefName,baseRefOid,mergeable,reviewDecision,statusCheckRollup'], { env, timeoutMs: 60_000 });
  if (r.code !== 0) {
    log.warn('pr view failed', task.prUrl, r.stderr.trim().slice(0, 200));
    return;
  }
  const j = JSON.parse(r.stdout) as {
    state: 'OPEN' | 'MERGED' | 'CLOSED'; headRefName: string; headRefOid?: string; baseRefName?: string; baseRefOid?: string;
    mergeable?: string; reviewDecision?: string; statusCheckRollup?: RollupItem[];
  };
  if (j.state !== 'OPEN') return settle(watch, j.state, j.headRefName);
  const checks = parseChecks(j.statusCheckRollup);
  const ready = readiness(checks, j.mergeable, j.reviewDecision);
  for (const x of watch.tasks) {
    if (JSON.stringify(ready) === JSON.stringify(x.prChecks ?? null)) continue;
    x.prChecks = ready;
    store.changed();
  }
  // A Worker is already on it: this task, or a follow-up working on the same PR.
  if (task.status !== 'pr_open' || prBusy(watch.all)) return;
  // Comments and CI go to the task that opened the PR; it is told about anything a follow-up on the PR already handled.
  adoptSeen(task, watch.all);
  if (await sendComments(task)) return;
  // A conflict comes before CI: checks on a branch that cannot merge say little, and the merge starts them again.
  if (planConflictFix(task, ready.conflicts, j.headRefOid ?? '', j.baseRefOid ?? '')) {
    store.chat('event', t('ev.conflictFixing', { id: task.workerId ?? '', title: task.title }));
    workers.sendReview(task, conflictBody(j.baseRefName || 'main'), 'conflict');
    store.changed();
    return;
  }
  await fixCi(task, env, checks, j.headRefOid ?? '');
}

/**
 * Merge a task's PR on the user's click, the way its repository allows (squash first). The state is read again
 * first, so a PR that stopped being ready since the window last showed it is not merged.
 */
export async function mergePr(taskId: string) {
  const task = store.task(taskId);
  const p = task?.prUrl ? parsePr(task.prUrl) : null;
  if (!task || !p) throw new Error(t('pr.err.noPr'));
  const env = { ...ghEnv(), GH_HOST: p.host };
  const view = await run('gh', ['pr', 'view', task.prUrl!, '--json', 'state,mergeable,reviewDecision,statusCheckRollup'], { env, timeoutMs: 60_000 });
  if (view.code !== 0) throw new Error(view.stderr.trim().split('\n')[0] || t('pr.err.merge'));
  const j = JSON.parse(view.stdout) as { state: string; mergeable?: string; reviewDecision?: string; statusCheckRollup?: RollupItem[] };
  if (j.state !== 'OPEN' || !canMerge(readiness(parseChecks(j.statusCheckRollup), j.mergeable, j.reviewDecision))) {
    checkPrsSoon();
    throw new Error(t('pr.err.notReady'));
  }
  const repo = await run('gh', ['repo', 'view', `${p.host}/${p.owner}/${p.repo}`, '--json', 'squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed'], { env, timeoutMs: 60_000 });
  let allowed: Parameters<typeof mergeMethod>[0] = null;
  try { if (repo.code === 0) allowed = JSON.parse(repo.stdout); } catch { /* squash */ }
  const method = mergeMethod(allowed);
  const r = await run('gh', ['pr', 'merge', task.prUrl!, `--${method}`], { env, timeoutMs: 120_000 });
  if (r.code !== 0) throw new Error(r.stderr.trim().split('\n')[0] || t('pr.err.merge'));
  log.info('merged from the app', task.prUrl, method);
  // Read it again at once, whenever the last round was: the task shows as merged now, not at the next round.
  void checkPrs();
}

let running = false;
/** A round was asked for while one was under way: it may have read a PR before the change, so one more follows. */
let again = false;
let lastRun = 0;
export async function checkPrs() {
  if (running) { again = true; return; }
  running = true;
  lastRun = Date.now();
  try {
    // While a Worker is fixing review comments the task is "running"; still notice a merge.
    for (const watch of prsToWatch(store.data.tasks)) {
      try { await checkOne(watch); } catch (e) { log.warn('pr check', watch.url, (e as Error).message); }
    }
  } finally {
    running = false;
    if (again) { again = false; void checkPrs(); }
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
