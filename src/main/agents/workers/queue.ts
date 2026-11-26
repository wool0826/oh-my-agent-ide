import { accounts } from '../../accounts';
import { limitResetText, t } from '../../i18n';
import { cachedModels } from '../../models';
import { loadSettings } from '../../settings';
import { store } from '../../store';
import { log } from '../../log';
import { ghEnv } from '../../repos';
import { nowIso, run } from '../../util';
import { needsPlan, taskStarted } from '../workerPrompt';
import { RESUME_MSG, stallMsg } from '../workerText';
import type { WorkerManager, WorkerSession } from '../workers';
import { WORKER_TASK_COMPACT } from '../../../shared/context';
import { providerOf } from '../../../shared/models';
import { isLocalRepo } from '../../../shared/localRepo';
import { afterDependency, branchPrDue, cancelWhy, describeCancel, pickBranchPr } from '../../../shared/queue';
import { canStart, queueOrder, slotsUsed, waitStep, waitsForSlot } from '../../../shared/slots';
import { isStalled } from '../../../shared/stall';
import { setStatus } from '../../../shared/taskStatus';
import type { Task, Worker } from '../../../shared/types';
import { restoreWorker } from './archive';
import { cancelNow, tidyCancelled } from './cancel';
import { deliver, sendFeedback, taskMessage, withNotes } from './messages';
import { unanswered } from './questions';
import { checkpoint, fail } from './results';

/** Assign a task. With workerId, that Worker continues with its context. */
export async function assign(m: WorkerManager, task: Task, workerId: string | null, model: string): Promise<Worker> {
  let w = workerId ? store.worker(workerId) : null;
  if (workerId && !w) throw new Error(t('err.noWorker', { id: workerId }));
  if (w && w.repo !== task.repo && task.kind === 'code') throw new Error(t('err.wrongRepo', { id: w.id, has: w.repo ?? t('general'), want: task.repo ?? '' }));
  if (!w) w = await m.create({ title: task.title, repo: task.kind === 'code' ? task.repo : null, model });
  if (w.status === 'archived') await m.unarchive(w);
  task.workerId = w.id;
  if (task.kind === 'code') task.branch = `agent/${task.id.toLowerCase()}`;
  w.taskIds.push(task.id);
  task.updatedAt = nowIso();
  store.log(w.id, 'dispatcher', `[Task ${task.id}] ${task.title}\n\n${task.prompt}`);
  if (task.afterTaskId) {
    // Wait until that PR is merged; the PR monitor starts it.
    task.status = 'blocked';
    store.log(w.id, 'event', t('log.blocked', { id: task.afterTaskId }));
    store.changed();
    // It may have ended while this Worker was being set up.
    const dep = store.task(task.afterTaskId);
    if (afterDependency(dep) !== 'wait') settleAllBlocked(m);
    return w;
  }
  if (!hasSlot(m, w)) {
    waitForSlot(m, w, task);
    return w;
  }
  w.title = task.title;
  task.status = 'running';
  store.changed();
  dispatch(m, w, task);
  return w;
}

/** The PR that blocked tasks were waiting for was merged (or closed). */
export function onPrSettled(m: WorkerManager, doneTask: Task, merged: boolean) {
  settleBlocked(m, doneTask, merged ? 'start' : 'cancel');
}

/**
 * A task ended (or the app started): tasks waiting on it with after_task_id start or are cancelled, as
 * afterDependency says. Without this, a dependency that finished without a PR, or failed, would hold them forever.
 */
export function followUp(m: WorkerManager, dep: Task) {
  const waits = store.data.tasks.some((x) => x.status === 'blocked' && x.afterTaskId === dep.id);
  const repo = dep.repo ? store.repo(dep.repo) : null;
  if (waits && branchPrDue(dep, isLocalRepo(repo), m.branchChecked.has(dep.id))) return void adoptBranchPr(m, dep);
  const how = afterDependency(dep);
  if (how !== 'wait') settleBlocked(m, dep, how);
}

/**
 * A code task finished with no PR known, and tasks wait on it: GitHub may know one its Worker opened without naming
 * it in a RESULT line (T-0136). It is recorded (an open one makes the task pr_open), then the waiting tasks settle
 * as afterDependency says. When gh cannot tell, they start as before.
 */
async function adoptBranchPr(m: WorkerManager, dep: Task) {
  m.branchChecked.add(dep.id);
  const w = dep.workerId ? store.worker(dep.workerId) : null;
  const cwd = w?.cwd ?? store.repo(dep.repo!)?.path;
  const r = await run('gh', ['pr', 'list', '--head', dep.branch!, '--state', 'all', '--json', 'url,state', '--limit', '10'], { cwd, env: ghEnv(), timeoutMs: 60_000 });
  let list: unknown;
  try { list = r.code === 0 ? JSON.parse(r.stdout) : null; } catch { list = null; }
  const pr = pickBranchPr(list);
  const cur = store.task(dep.id);
  if (!cur) return;
  if (pr && !cur.prUrl && cur.status === 'done') {
    cur.prUrl = pr.url;
    cur.prState = pr.state;
    if (pr.state === 'OPEN') setStatus(cur, 'pr_open');
    cur.reviewSyncedAt ??= nowIso();
    cur.updatedAt = nowIso();
    log.info(`[${cur.workerId}] ${cur.id} has ${pr.state === 'OPEN' ? 'open' : 'merged'} PR ${pr.url} on ${cur.branch}; its report named none`);
    store.pushUpdate(`${cur.id} "${cur.title}" finished without naming a PR, but its branch ${cur.branch} has ${pr.state === 'OPEN' ? 'open' : 'merged'} PR ${pr.url}; it is recorded${pr.state === 'OPEN' ? ' and the tasks waiting on it wait for its merge' : ''}.`);
    store.changed();
  }
  followUp(m, cur);
}

/** Every blocked task whose dependency already ended, as saved state may hold (one that ended before this check existed). */
export function settleAllBlocked(m: WorkerManager) {
  const deps = new Set(store.data.tasks.filter((x) => x.status === 'blocked' && x.afterTaskId).map((x) => x.afterTaskId!));
  for (const id of deps) {
    const dep = store.task(id);
    if (dep) followUp(m, dep);
    else settleBlocked(m, { id, title: id } as Task, 'cancel');
  }
}

export function settleBlocked(m: WorkerManager, dep: Task, how: 'start' | 'cancel') {
  const waiting = store.data.tasks.filter((x) => x.status === 'blocked' && x.afterTaskId === dep.id && x.workerId && store.worker(x.workerId));
  if (!waiting.length) return;
  if (how === 'cancel') return cancelBlocked(m, dep, waiting);
  const merged = dep.prState === 'MERGED';
  for (const task of waiting) {
    const w = store.worker(task.workerId!)!;
    const slot = hasSlot(m, w);
    if (!merged) store.pushUpdate(`${task.id} "${task.title}" (${w.id}) waited for ${dep.id}, which finished without a PR; it ${slot ? 'started' : 'now waits for a free Worker slot'}.`);
    if (!slot) {
      store.log(w.id, 'event', t(merged ? 'log.blockedMerged' : 'log.blockedDone', { id: dep.id }));
      waitForSlot(m, w, task);
      continue;
    }
    task.status = 'running';
    task.updatedAt = nowIso();
    w.title = task.title;
    store.chat('event', t(merged ? 'ev.blockedStarted' : 'ev.blockedStartedDone', { id: w.id, title: task.title, dep: dep.title }));
    store.log(w.id, 'event', t(merged ? 'log.blockedStarted' : 'log.blockedStartedDone', { id: dep.id }));
    dispatch(m, w, task);
  }
  store.changed();
}

/**
 * What the blocked tasks build on never comes: they are cancelled, with the tasks waiting on them, like a
 * cancel from the queue. The Dispatcher hears why, so it can plan them again.
 */
export function cancelBlocked(m: WorkerManager, dep: Task, waiting: Task[]) {
  const why = cancelWhy(dep, !!store.task(dep.id));
  const reports = cancelNow(m, waiting.map((x) => x.id), dep.id, why);
  if (!reports.length) return;
  for (const r of reports) {
    if (r.followerOf !== dep.id) continue;
    if (why === 'closed') store.chat('error', t('ev.blockedCancelled', { title: r.title, dep: dep.title }), r.id);
    else store.chat('event', t(why === 'gone' ? 'ev.cancelled' : 'ev.blockedFailed', { title: r.title, dep: dep.title }), r.id);
  }
  const reason = why === 'closed' ? 'had its PR closed without merging' : why === 'gone' ? 'no longer exists' : `ended as ${dep.status} with no PR to merge`;
  store.pushUpdate(`${dep.id}${why === 'gone' ? '' : ` "${dep.title}"`} ${reason}, so the tasks waiting for it were cancelled: ${reports.map(describeCancel).join('; ')}. If they are still wanted, create them again (with after_task_id once ${dep.id} or a replacement is in progress).`);
  store.changed();
  void tidyCancelled(m, reports);
}

export function dispatch(m: WorkerManager, w: Worker, task: Task) {
  const s = m.ensureSession(w);
  if (!s) return pause(m, w, task);
  startTask(m, w, s, task);
}

/**
 * Send the task message, with the task's effort and plan mode in place first; `after` follows it.
 * A Worker with a large context from earlier tasks is compacted first; the message waits for that.
 */
export function startTask(m: WorkerManager, w: Worker, s: WorkerSession, task: Task, after: string[] = []) {
  task.startedAt = nowIso();
  checkpoint(m, w, task.title);
  if ('compactFirst' in s) s.compactFirst(WORKER_TASK_COMPACT, w.contextTokens);
  s.setEffort(m.effortFor(task));
  // Plan mode must be in place before the task message arrives.
  void s.setMode(needsPlan(task) ? 'plan' : 'auto').then(() => {
    s.send(withNotes(m, w, taskMessage(m, w, task)));
    after.forEach((msg) => s.send(msg));
  });
  store.changed();
}

/** Every account is held by a usage limit: the task waits in the queue until the first one resets. */
export function pause(m: WorkerManager, w: Worker, task: Task | null) {
  if (task) { task.status = 'queued'; task.queueReason = 'limit'; task.updatedAt = nowIso(); }
  const time = limitResetText(accounts.nextFreeAt(providerOf(w.model, cachedModels().models)));
  w.status = 'idle';
  w.statusText = t('st.limitUntil', { time });
  store.log(w.id, 'event', t('log.limitWait', { time }));
  store.changed();
}

/** Its Worker already holds a slot, or one is free (Settings > Models > Workers at once). */
export function hasSlot(m: WorkerManager, w: Worker) {
  return canStart(store.data.tasks, w.id, loadSettings().maxWorkers);
}

/**
 * Every Worker slot is taken: the task waits in the queue, and `msg` (if any) waits with it.
 * A task already queued keeps its place; fillSlots starts the longest waiting first.
 */
export function waitForSlot(m: WorkerManager, w: Worker, task: Task, msg?: string) {
  if (task.status !== 'queued') task.updatedAt = nowIso();
  task.status = 'queued';
  task.queueReason = 'slot';
  if (msg) m.held.set(w.id, [...(m.held.get(w.id) ?? []), msg]);
  w.statusText = t('st.slotUntil');
  store.log(w.id, 'event', t('log.slotWait', { n: slotsUsed(store.data.tasks), max: loadSettings().maxWorkers }));
  store.changed();
}

export function hold(m: WorkerManager, w: Worker, msg: string) {
  m.held.set(w.id, [...(m.held.get(w.id) ?? []), msg]);
  // Its task cannot go on before the limit resets either (the session is gone), so it waits in the queue.
  const task = m.currentTask(w);
  if (task?.status === 'running') { task.status = 'queued'; task.queueReason = 'limit'; task.updatedAt = nowIso(); }
  const time = limitResetText(accounts.nextFreeAt(providerOf(w.model, cachedModels().models)));
  w.statusText = t('st.limitUntil', { time });
  store.log(w.id, 'event', t('log.limitHeld', { time }));
  store.changed();
}

/**
 * Run every half minute: a task that has waited for an answer longer than the setting allows gives its slot
 * back, and the tasks queued for one start. The waiting Worker is not stopped and runs again when answered.
 */
export function sweepWaiting(m: WorkerManager, now = Date.now()) {
  const minutes = loadSettings().waitSlotMinutes;
  let changed = false;
  let released = false;
  for (const task of store.data.tasks) {
    const step = waitStep(task, now, minutes);
    if (!step) continue;
    changed = true;
    if (step === 'mark') task.waitingSince = new Date(now).toISOString();
    else if (step === 'clear') { task.waitingSince = null; task.slotReleased = false; }
    else {
      task.slotReleased = true;
      released = true;
      if (task.workerId) store.log(task.workerId, 'event', t('log.slotReleased', { n: minutes }));
    }
  }
  if (changed) store.changed();
  if (released) m.fillSlots();
}

/**
 * Open tasks that nothing runs any more (shared/stall.ts): the Worker is reminded once to go on; if it stalls again,
 * it shows as stalled and the Dispatcher is told, rather than the Worker sitting idle without a word.
 */
export function sweepStalled(m: WorkerManager, now = Date.now()) {
  // A task that settled starts afresh if a follow-up reopens it.
  for (const id of m.stallNudged) if (store.task(id)?.status !== 'running') m.stallNudged.delete(id);
  for (const w of store.data.workers) {
    const task = m.currentTask(w);
    const s = m.sessions.get(w.id) ?? null;
    if (w.stalledAt) {
      // Its task ended or moved on another way (a Stop, a cancel, a reply that started no turn).
      if (!isStalled(w, task, s, now, 0)) { w.stalledAt = null; store.changed(); }
      continue;
    }
    if (!task || !isStalled(w, task, s, now)) continue;
    const min = Math.round((now - Date.parse(w.lastActiveAt)) / 60_000);
    if (s && !s.closed && !m.stallNudged.has(task.id)) {
      m.stallNudged.add(task.id);
      store.log(w.id, 'event', t('log.stallNudge', { min }));
      s.send(stallMsg(task.id, min, !!s.shells));
      m.touch(w);
      continue;
    }
    w.stalledAt = new Date(now).toISOString();
    // Shown as running while it waited on background shells; stalled is shown on an idle Worker.
    if (w.status === 'running') { w.status = 'idle'; w.statusText = ''; }
    store.log(w.id, 'event', t('log.stalled', { min }));
    store.pushUpdate(`${w.id} (${task.id} "${task.title}") looks stalled: its task is open, but its session has been idle for ${min} min with ${s?.shells ? `only ${s.shells} background command(s) left running (a server or a hung run?)` : 'nothing running'}${m.stallNudged.has(task.id) ? ', even after a reminder to go on' : ''}. send_to_worker to tell it how to go on, or stop it.`, true);
    store.changed();
  }
}

/**
 * A slot may be free: a task finished or failed, a session went idle, or the limit was raised.
 * Tasks waiting for one start, the longest waiting first. Running Workers are never stopped for a lower limit.
 */
export function fillSlots(m: WorkerManager) {
  for (const task of queueOrder(store.data.tasks, 'slot')) {
    const w = task.workerId ? store.worker(task.workerId) : null;
    if (!w || !waitsForSlot(task) || !hasSlot(m, w)) continue;
    // Its worktree is made again first; the queue is filled again once it is there.
    if (w.status === 'archived') {
      // Without its worktree the task cannot run: it fails once, rather than every time the queue is filled.
      void restoreWorker(m, w).then((err) => (err === null ? m.fillSlots() : fail(m, w, task, err)));
      continue;
    }
    const s = m.ensureSession(w);
    // A usage limit holds every account now: it waits for that instead.
    if (!s) { pause(m, w, task); continue; }
    if (!taskStarted(w, task)) w.title = task.title;
    deliver(m, w, s, [], task);
  }
  sendFeedback(m);
}

/**
 * A usage limit reset (or an account was added): continue paused tasks and send held messages.
 * Paused tasks had a slot, so they take free ones before tasks waiting for a slot; past the limit they wait too.
 */
export function retryQueued(m: WorkerManager) {
  for (const task of queueOrder(store.data.tasks, 'limit')) {
    const w = task.workerId ? store.worker(task.workerId) : null;
    const s = w && m.ensureSession(w);
    if (!w || !s) continue;
    if (hasSlot(m, w)) deliver(m, w, s, [], task);
    else waitForSlot(m, w, task);
  }
  for (const id of [...m.held.keys()]) {
    const w = store.worker(id);
    if (!w) { m.held.delete(id); continue; }
    // Held for a task that waits for a slot: they go out when it starts.
    const cur = m.currentTask(w);
    if (cur && waitsForSlot(cur)) continue;
    const s = m.ensureSession(w);
    if (s) deliver(m, w, s, []);
  }
  m.fillSlots();
}

/**
 * On app start no session is left. A Worker that was busy continues its task. A Worker that ended in an error
 * gets its unfinished task failed, as a session error does now (state saved before that rule could disagree).
 * Paused tasks start right away when their limit reset while the app was closed.
 * Interrupted work takes the free slots first, in Worker order; past the limit (lowered meanwhile) it waits for one.
 */
export function resumeAfterRestart(m: WorkerManager) {
  const resume: { w: Worker; task: Task }[] = [];
  const failed: { w: Worker; task: Task }[] = [];
  for (const w of store.data.workers) {
    const task = m.currentTask(w);
    const inProgress = task && (task.status === 'running' || task.status === 'waiting');
    // An older version archived Workers mid-task; nobody will finish that task, so it failed.
    if (w.status === 'archived') {
      if (inProgress) failed.push({ w, task });
      continue;
    }
    // The turn that would have answered is gone with the session, and so is a question that was held.
    if (w.ask) unanswered(m, w, 'the app restarted', false);
    if (w.status === 'error') {
      if (inProgress) failed.push({ w, task });
      continue;
    }
    const busy = w.status === 'running' || w.status === 'waiting' || w.status === 'starting';
    w.status = 'idle';
    // A Worker saved as busy on a paused task (an older version left them so) was really running it.
    if (!task || (!inProgress && !busy)) continue;
    // Its turn had ended and the task waits for the Dispatcher's answer: nothing was interrupted.
    if (w.request && task.status === 'waiting' && !busy) continue;
    resume.push({ w, task });
  }
  const settling = new Set([...resume, ...failed].map((r) => r.task));
  let free = loadSettings().maxWorkers - slotsUsed(store.data.tasks.filter((x) => !settling.has(x)));
  for (const { w, task } of resume) {
    if (free <= 0) { waitForSlot(m, w, task, taskStarted(w, task) ? RESUME_MSG : undefined); continue; }
    free -= 1;
    const s = m.ensureSession(w);
    if (!s) { pause(m, w, task); continue; }
    setStatus(task, 'running');
    task.updatedAt = nowIso();
    store.log(w.id, 'event', t('log.restarted'));
    if (taskStarted(w, task)) s.send(RESUME_MSG);
    else startTask(m, w, s, task);
  }
  // After the resumes, so the slots these free go to tasks that waited for one, oldest first.
  for (const { w, task } of failed) fail(m, w, task, w.statusText);
  settleAllBlocked(m);
  store.changed();
  m.retryQueued();
}

/** The task's own effort when per-task effort is on, otherwise the Worker default. */
export function effortFor(m: WorkerManager, task: Task | null) {
  const st = loadSettings();
  return (st.effortPerTask && task?.effort) || st.workerEffort;
}
