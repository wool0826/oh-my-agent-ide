import fs from 'node:fs';
import { store } from './store';
import { workers } from './agents/workers';
import { cleanupBranch, ghEnv } from './repos';
import { notifyInfo } from './notify';
import { t } from './i18n';
import { run, nowIso } from './util';
import { log } from './log';
import { automations } from './automations';
import { ask, waitFor } from './decisions';
import { MAX_CI_FIXES, ciFixBody, failedLogTail, parseChecks, planCiFix, readiness, runsOf, type Check, type RollupItem } from './prchecks';
import { adoptSeen, isBot, parsePages, prBusy, prsToWatch, type PrWatch } from '../shared/prs';
import { ciReason } from '../shared/askWhy';
import { canMerge, conflictBody, mergeMethod, planConflictFix } from '../shared/prMerge';
import { PR_POLL, eachLimited, isFullRound, isRateLimited, nextPollDelay, parsePrUrl, prStateQueries, readPrStates, type PrState } from '../shared/prPoll';
import type { Decision, Task } from '../shared/types';

/**
 * Watch open PRs.
 * - Merged or closed: delete the branch (local and remote), finish the task,
 *   notify, and start tasks that were waiting for this merge.
 * - Keep the merge readiness (CI, conflicts, review) on the task for the UI.
 * - New review comments, then a conflict with the base, then failed CI: hand them to the Worker that opened the PR.
 * - Each PR once, even when a follow-up task pushed to its branch and recorded the same URL.
 */

const parsePr = parsePrUrl;

interface Comment { id: string; author: string; body: string; where: string }

async function fetchComments(task: Task): Promise<Comment[] | null> {
  const p = parsePr(task.prUrl!);
  if (!p) return null;
  const env = { ...ghEnv(), GH_HOST: p.host };
  const out: Comment[] = [];
  const view = await run('gh', ['pr', 'view', task.prUrl!, '--json', 'comments,reviews'], { env, timeoutMs: 60_000 });
  if (view.code !== 0) return null;
  const j = JSON.parse(view.stdout);
  for (const c of j.comments ?? []) if (!isBot(c.author?.login ?? '')) out.push({ id: `c:${c.id}`, author: c.author?.login ?? '?', body: c.body ?? '', where: 'conversation' });
  for (const r of j.reviews ?? []) if (r.body?.trim() && !isBot(r.author?.login ?? '')) out.push({ id: `r:${r.id}`, author: r.author?.login ?? '?', body: r.body, where: `review (${r.state})` });
  const inline = await run('gh', ['api', `repos/${p.owner}/${p.repo}/pulls/${p.num}/comments`, '--paginate'], { env, timeoutMs: 60_000 });
  if (inline.code !== 0) return out;
  // With more than one page, gh prints one array per page. A page that does not parse: try again next round.
  const pages = parsePages<{ id: number; user?: { login?: string; type?: string }; body?: string; path?: string; line?: number | null; original_line?: number | null }>(inline.stdout);
  if (!pages) {
    log.warn('pr comments unreadable', task.prUrl, inline.stdout.slice(0, 200));
    return null;
  }
  for (const c of pages) if (!isBot(c.user?.login ?? '', c.user?.type)) out.push({ id: `i:${c.id}`, author: c.user?.login ?? '?', body: c.body ?? '', where: `${c.path}:${c.line ?? c.original_line ?? ''}` });
  return out;
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
  if (!watch.announced) {
    const text = merged ? t('ev.prMerged', { title: first.title }) : t('ev.prClosed', { title: first.title });
    store.chat('event', text);
    for (const id of new Set(tasks.map((x) => x.workerId))) if (id && store.worker(id)) store.log(id, 'event', text);
    const also = tasks.length > 1 ? ` (also recorded by ${tasks.slice(1).map((x) => x.id).join(', ')})` : '';
    store.pushUpdate(`${first.id} "${first.title}" PR ${merged ? 'merged' : 'closed without merging'}${also}; branch cleaned up`);
    notifyInfo(merged ? t('noti.merged') : t('noti.closed'), first.title);
  }
  // Tasks waiting (after_task_id) on any of them start, or are cancelled if the PR was closed. Before the branch
  // cleanup below, which fetches and pushes: the board and the waiting tasks should not wait for the network.
  // A follow-up started here in the same worktree puts that worktree's cleanup off (see inUse below).
  for (const task of settling) workers.onPrSettled(task, merged);
  store.changed();
  // The PR's branch, plus a follow-up's own branch if it made one before pushing to the PR's.
  const cleaned = new Set<string>();
  for (const task of tasks) {
    const repo = task.repo ? store.repo(task.repo) : null;
    const branch = task.branch ?? headRef;
    if (!repo || !branch || cleaned.has(branch)) continue;
    cleaned.add(branch);
    const w = task.workerId ? store.worker(task.workerId) : null;
    const worktree = w?.repo === repo.name ? w.cwd : null;
    // Not under a turn in that worktree: switching its branch would pull the files from under the Worker.
    if (w && worktree && workers.inUse(w.id)) { cleanupLater.push({ repo: repo.name, worktree, branch, workerId: w.id }); continue; }
    await cleanupBranch(repo, worktree, branch).catch((e) => log.warn('cleanup', e));
  }
}

/** settle() one PR at a time: PRs checked side by side must not run git in the same repository at once. */
let settleChain: Promise<unknown> = Promise.resolve();
function settleInTurn(watch: PrWatch<Task>, state: 'MERGED' | 'CLOSED', headRef: string) {
  const p = settleChain.then(() => settle(watch, state, headRef));
  settleChain = p.catch(() => {});
  return p;
}

/** Hand new review comments to the Worker. True when some were sent. */
async function sendComments(task: Task) {
  // With no Worker to hand them to, they are not marked seen: they go to a Worker that takes the PR later.
  if (!task.workerId || !store.worker(task.workerId)) return false;
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
    source: 'question', kind: 'ci', workerId: task.workerId, taskId: task.id,
    title: t('ci.capTitle', { n: MAX_CI_FIXES }), detail: names, code: null,
    options: [{ label: retry, description: t('ci.retryDesc', { n: MAX_CI_FIXES }) }, { label: leave, description: t('ci.leaveDesc') }],
    questionKey: null,
    reason: ciReason(t, { who: task.workerId ?? 'Worker', task, prNum: task.prUrl?.match(/\/pull\/(\d+)/)?.[1] ?? '?', fixes: MAX_CI_FIXES, names }),
  }, entry.abort.signal).then(onCiAnswer(task, entry, retry, leave), () => asking.delete(task.id));
}

/** The user's answer to the CI question: keep fixing (with what they typed, if anything), or leave it. */
function onCiAnswer(task: Task, entry: { body: string }, retry: string, leave: string) {
  return (ans: string) => {
    asking.delete(task.id);
    if (ans === leave || task.prState !== 'OPEN') return;
    task.ciFixAttempts = 0;
    sendCiFix(task, ans === retry ? entry.body : `${entry.body}\n\nThe user says: ${ans}`);
  };
}

/**
 * After a restart, wait again for a CI question left open, so its answer still keeps fixing (its failed runs are
 * marked handled and would not ask again). The failure logs went with the last run; the Worker reads them itself.
 * False when it no longer applies (the task or its open PR is gone), and it should be withdrawn.
 */
export function resumeCiQuestion(d: Decision): boolean {
  const task = d.taskId ? store.task(d.taskId) : null;
  if (d.kind !== 'ci' || !task?.prUrl || task.prState !== 'OPEN' || asking.has(task.id)) return false;
  const entry = { body: `Checks still fail on ${task.prUrl}: ${d.detail}. Read their logs with \`gh run view --log-failed\`.`, abort: new AbortController() };
  asking.set(task.id, entry);
  // The labels the card shows, in the language it was asked in.
  waitFor(d.id, entry.abort.signal).then(onCiAnswer(task, entry, d.options[0]?.label ?? '', d.options[1]?.label ?? ''), () => asking.delete(task.id));
  return true;
}

async function checkOne(watch: PrWatch<Task>) {
  const task = watch.tasks[0];
  const p = parsePr(task.prUrl!);
  if (!p) return;
  const env = { ...ghEnv(), GH_HOST: p.host };
  const r = await run('gh', ['pr', 'view', task.prUrl!, '--json', 'state,headRefName,headRefOid,baseRefName,baseRefOid,mergeable,reviewDecision,statusCheckRollup'], { env, timeoutMs: 60_000 });
  if (r.code !== 0) {
    if (isRateLimited(r.stderr)) roundFailed = true;
    log.warn('pr view failed', task.prUrl, r.stderr.trim().slice(0, 200));
    return;
  }
  const j = JSON.parse(r.stdout) as {
    state: 'OPEN' | 'MERGED' | 'CLOSED'; headRefName: string; headRefOid?: string; baseRefName?: string; baseRefOid?: string;
    mergeable?: string; reviewDecision?: string; statusCheckRollup?: RollupItem[];
  };
  if (j.state !== 'OPEN') return settleInTurn(watch, j.state, j.headRefName);
  const checks = parseChecks(j.statusCheckRollup);
  const ready = readiness(checks, j.mergeable, j.reviewDecision);
  for (const x of watch.tasks) {
    if (JSON.stringify(ready) === JSON.stringify(x.prChecks ?? null)) continue;
    x.prChecks = ready;
    store.changed();
  }
  // A Worker is already on it: this task, or a follow-up working on the same PR.
  if (task.status !== 'pr_open' || prBusy(watch.all)) return;
  // Its repository was removed, and its Worker with it: only the merge is still noticed.
  if (task.repo && !store.repo(task.repo)) return;
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
    void checkPrs({ full: true });
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

/** Branch cleanups put off while the Worker was in a turn in that worktree; each PR round tries them again. */
const cleanupLater: { repo: string; worktree: string; branch: string; workerId: string }[] = [];

async function cleanUpLeft() {
  for (const c of cleanupLater.splice(0)) {
    const repo = store.repo(c.repo);
    if (!repo) continue;
    if (store.worker(c.workerId) && workers.inUse(c.workerId)) { cleanupLater.push(c); continue; }
    // The worktree may have gone meanwhile (the Worker archived): then only the branch is cleaned up.
    await cleanupBranch(repo, fs.existsSync(c.worktree) ? c.worktree : null, c.branch).catch((e) => log.warn('cleanup', e));
  }
}

/** Cleanups still put off (for tests). */
export const pendingCleanups = () => cleanupLater.map((c) => c.branch);

let running = false;
/** A round was asked for while one was under way: it may have read a PR before the change, so one more follows. */
let again = false;
let lastRun = 0;
/** When the last full round (CI, conflicts, comments) ran, and whether one was asked for. */
let lastFull = 0;
let fullAsked = false;
/** Rounds in a row that failed (the state query failed, or GitHub limited the calls): the next ones wait longer. */
let failures = 0;
let roundFailed = false;
let timer: NodeJS.Timeout | null = null;
/** When the timer is due (ms since epoch). */
let dueAt = 0;
let started = false;
/** Callers waiting for the round in progress (and the one it asked for) to end. */
const roundWaiters: (() => void)[] = [];

/**
 * The state of every watched PR, in one call per host. A PR missing from the map is unknown: its host's call
 * failed (then `failed` is set), or the answer had no state for it (deleted, no access, or a URL the query skips).
 */
async function readStates(urls: string[]): Promise<{ states: Map<string, PrState>; failed: boolean }> {
  const states = new Map<string, PrState>();
  let failed = false;
  for (const q of prStateQueries(urls)) {
    const r = await run('gh', ['api', 'graphql', '-f', `query=${q.query}`], { env: { ...ghEnv(), GH_HOST: q.host }, timeoutMs: 60_000 });
    // A PR that is gone makes gh exit 1 while the others are still in the answer.
    const got = readPrStates(r.stdout, q.keys);
    if (!got) {
      failed = true;
      log.warn('pr states failed', q.host, r.stderr.trim().slice(0, 200));
      continue;
    }
    if (isRateLimited(r.stderr)) failed = true;
    for (const [url, s] of got) states.set(url, s);
  }
  return { states, failed };
}

/**
 * One round. Every round reads all watched PRs' states in one call and settles the merged and closed ones at once.
 * A full round (asked for, or every PR_POLL.full) also reads CI, conflicts and review comments of the open ones,
 * a few PRs at a time, and checks the PRs the state call could not read (only then: not one call per PR every round).
 */
export async function checkPrs(opts: { full?: boolean } = {}): Promise<void> {
  if (opts.full) fullAsked = true;
  if (running) { again = true; return; }
  running = true;
  lastRun = Date.now();
  roundFailed = false;
  try {
    await cleanUpLeft();
    // While a Worker is fixing review comments the task is "running"; still notice a merge.
    const watches = prsToWatch(store.data.tasks);
    const full = isFullRound(Date.now(), lastFull, fullAsked);
    fullAsked = false;
    if (full) lastFull = Date.now();
    const { states, failed } = watches.length ? await readStates(watches.map((x) => x.url)) : { states: new Map<string, PrState>(), failed: false };
    if (failed) roundFailed = true;
    const rest: PrWatch<Task>[] = [];
    for (const watch of watches) {
      const s = states.get(watch.url);
      if (s && s.state !== 'OPEN') {
        try { await settleInTurn(watch, s.state, s.headRefName); } catch (e) { log.warn('pr settle', watch.url, (e as Error).message); }
      } else if (full) rest.push(watch);
    }
    await eachLimited(rest, PR_POLL.parallel, async (watch) => {
      try { await checkOne(watch); } catch (e) { log.warn('pr check', watch.url, (e as Error).message); }
    });
  } catch (e) {
    // Not thrown on: callers fire and forget, and the round still counts as failed for the backoff.
    roundFailed = true;
    log.warn('pr round', (e as Error).message);
  } finally {
    running = false;
    failures = roundFailed ? failures + 1 : 0;
    if (again) { again = false; void checkPrs(); } else {
      for (const done of roundWaiters.splice(0)) done();
      schedule();
    }
  }
}

/** Set the next round: soon while a PR is watched, slowly otherwise, later after failures. */
function schedule() {
  if (!started) return;
  if (timer) clearTimeout(timer);
  const ms = nextPollDelay(prsToWatch(store.data.tasks).length > 0, failures);
  dueAt = Date.now() + ms;
  timer = setTimeout(() => { timer = null; void checkPrs(); }, ms);
  timer.unref();
}

/** Check at once when the window comes back to the front, at most every PR_POLL.focus. */
export function checkPrsSoon() {
  if (Date.now() - lastRun > PR_POLL.focus) void checkPrs();
}

/** "Check PRs now": a full round at once, whenever the last one was. Resolves (true) once that round is over. */
export function checkPrsNow(): Promise<boolean> {
  // Clicked again right after a full round: that one is still news enough, and each full round costs calls per PR.
  if (!running && Date.now() - lastFull < PR_POLL.focus) return Promise.resolve(true);
  return new Promise((done) => {
    roundWaiters.push(() => done(true));
    void checkPrs({ full: true });
  });
}

/**
 * On every state change: a PR to watch appeared while the slow timer runs, so the next round comes at the fast
 * pace instead. A timer already due sooner is left alone (changes come often; resetting it would put it off).
 */
export function prWatchChanged() {
  if (running || !timer || failures) return;
  if (dueAt - Date.now() > PR_POLL.fast && prsToWatch(store.data.tasks).length) schedule();
}

export function startPrMonitor() {
  started = true;
  dueAt = Date.now() + 20_000;
  timer = setTimeout(() => { timer = null; void checkPrs({ full: true }); }, 20_000);
  timer.unref();
}
