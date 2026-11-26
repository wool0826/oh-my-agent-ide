import path from 'node:path';
import { t } from '../../i18n';
import { loadSettings } from '../../settings';
import { store } from '../../store';
import { nowIso, oneLine } from '../../util';
import { selfReviewLine } from '../selfReview';
import { STEPS_TASK_LINE } from '../stepsReminder';
import { needsPlan, taskStarted } from '../workerPrompt';
import { LIMIT_RESET_MSG, QUESTION_TAG, SLOT_FREE_MSG, planSummaryRule } from '../workerText';
import type { FeedbackKind, WorkerManager, WorkerSession } from '../workers';
import { isLocalRepo, localTaskLines } from '../../../shared/localRepo';
import { waitsForSlot } from '../../../shared/slots';
import { canReopen, setStatus } from '../../../shared/taskStatus';
import type { Task, Worker } from '../../../shared/types';
import { restoreWorker } from './archive';
import { hasSlot, hold, startTask, waitForSlot } from './queue';
import { checkpoint } from './results';

export function taskMessage(m: WorkerManager, w: Worker, task: Task) {
  const repo = task.repo ? store.repo(task.repo) : null;
  const head = [`[Task ${task.id}] ${task.title}`];
  if (task.kind === 'code' && repo) {
    head.push(`Repository: ${repo.name} (default branch ${repo.defaultBranch})`);
    if (isLocalRepo(repo)) head.push(...localTaskLines(repo, task.branch!));
    else head.push(`Branch: ${task.branch}. Start with \`git fetch origin\` then \`git switch -c ${task.branch} origin/${repo.defaultBranch}\`. If you are already on that branch, continue there.`);
    const review = selfReviewLine(loadSettings().selfReview, repo.defaultBranch, isLocalRepo(repo));
    if (review) head.push(review);
  } else {
    head.push(`Output folder: ${path.join(w.cwd, task.id)}`);
  }
  if (needsPlan(task)) head.push(`Plan first: you are in plan mode (read-only). Investigate, then present your plan with ExitPlanMode. ${planSummaryRule()} The user approves it before you change anything; if they ask for changes, revise and present it again. Once it is approved, carry out the plan in this session and report the finished work.`);
  if (task.afterTaskId) {
    const dep = store.task(task.afterTaskId);
    if (dep?.prUrl && dep.prState === 'MERGED') head.push(`This task builds on ${dep.prUrl}, which has been merged into the default branch.`);
    else if (dep?.status === 'done') head.push(`This task waited for ${dep.id} "${dep.title}", which finished without a PR: ${dep.summary ?? ''}${dep.files.length ? ` Files: ${dep.files.join(', ')}` : ''}`);
    // A local-only repository's finished work is on its branch until the user merges it: build on that branch.
    if (dep?.status === 'done' && dep.branch && isLocalRepo(repo) && task.branch) head.push(`Its work is on branch ${dep.branch}, which may not be merged into ${repo!.defaultBranch} yet: unless it is, start your branch from it (\`git switch -c ${task.branch} ${dep.branch}\`) instead of ${repo!.defaultBranch}.`);
  }
  head.push(STEPS_TASK_LINE);
  return `${head.join('\n')}\n\n${task.prompt}`;
}

/**
 * Send to a Worker whose session is open. Messages held while a usage limit lasted, or while its task waited
 * for a slot, go first. A queued task runs again: it starts if the Worker never got it, and is told to continue
 * when there is nothing else to send. Otherwise a follow-up may reopen the last task (reopenLast);
 * a question from the Dispatcher is no follow-up and reopens nothing.
 */
export function deliver(m: WorkerManager, w: Worker, s: WorkerSession, msgs: string[], task = m.currentTask(w)) {
  const out = [...(m.held.get(w.id) ?? []), ...msgs];
  checkpoint(m, w, out[0] ?? task?.title ?? '');
  const paused = task?.status === 'queued';
  const slot = !!task && waitsForSlot(task);
  if (paused || m.held.has(w.id)) {
    m.held.delete(w.id);
    w.statusText = '';
    store.log(w.id, 'event', t(slot ? 'log.slotFree' : 'log.limitCleared'));
  }
  if (task && paused) {
    task.status = 'running';
    task.queueReason = null;
    task.updatedAt = nowIso();
    if (!taskStarted(w, task)) {
      startTask(m, w, s, task, out);
      return m.touch(w);
    }
    if (!out.length) out.push(slot ? SLOT_FREE_MSG : LIMIT_RESET_MSG);
  }
  if (out.some((msg) => !msg.startsWith(QUESTION_TAG))) reopenLast(m, w);
  out.forEach((msg, i) => s.send(i ? msg : withNotes(m, w, msg)));
  m.touch(w);
}

/** Instructions for a Worker. Says where the message is now: sent, or held for a slot or a usage limit. */
export async function send(m: WorkerManager, workerId: string, from: 'user' | 'dispatcher', text: string) {
  const w = store.worker(workerId);
  if (!w) throw new Error(t('err.noWorker', { id: workerId }));
  if (w.status === 'archived') await m.unarchive(w);
  store.log(w.id, from, text);
  if (from === 'user') store.pushUpdate(`The user wrote to ${w.id} directly: ${oneLine(text, 200)}`);
  // From either one, it answers what the Worker asked the Dispatcher for: a task that waited for that goes on.
  if (w.request) {
    const cur = m.currentTask(w);
    w.request = null;
    // What it asks with no task open is counted per Worker, from one answer to the next.
    m.requestWakes.delete(w.id);
    if (cur?.status === 'waiting' && !m.sessions.get(w.id)?.busy) {
      setStatus(cur, 'running');
      cur.updatedAt = nowIso();
      w.statusText = '';
    }
  }
  const how = post(m, w, `${from === 'user' ? '[User message]' : '[Dispatcher]'} ${text}`);
  // With no task to report on, what the turn says goes back to the Dispatcher as an update.
  if (from === 'dispatcher' && how === 'sent' && !m.currentTask(w)) m.replyOwed.add(w.id);
  return how;
}

/** Route a message to a Worker: now, or held until its task gets a slot or a usage limit resets. */
export function post(m: WorkerManager, w: Worker, msg: string): 'sent' | 'slot' | 'limit' {
  // Its task waits for a slot: the message goes out when the task starts. Work in progress is never held for one.
  const cur = m.currentTask(w);
  // A follow-up that reopens the last task starts work like a new task does, so it needs a free slot as well.
  const reopens = !cur && !msg.startsWith(QUESTION_TAG) && !hasSlot(m, w) ? reopenLast(m, w) : null;
  if (reopens) {
    waitForSlot(m, w, reopens, msg);
    return 'slot';
  }
  if (cur && waitsForSlot(cur)) {
    m.held.set(w.id, [...(m.held.get(w.id) ?? []), msg]);
    store.log(w.id, 'event', t('log.slotHeld'));
    store.changed();
    return 'slot';
  }
  // Paused for a usage limit: going on needs a slot like any other resume.
  if (cur?.status === 'queued' && !hasSlot(m, w)) {
    waitForSlot(m, w, cur, msg);
    return 'slot';
  }
  const s = m.ensureSession(w);
  if (!s) {
    hold(m, w, msg);
    return 'limit';
  }
  deliver(m, w, s, [msg], cur);
  return 'sent';
}

/** New review comments on a PR, its failed CI checks, or a conflict with its base. */
export function sendReview(m: WorkerManager, task: Task, body: string, kind: FeedbackKind = 'review') {
  const w = task.workerId ? store.worker(task.workerId) : null;
  if (!w) return;
  // The Worker is on another task: the turn that handled this would settle that one. It waits until that is settled.
  const other = m.currentTask(w);
  if (other && other.id !== task.id) {
    const list = m.feedback.get(w.id) ?? [];
    if (list.some((f) => f.taskId === task.id && f.kind === kind && f.body === body)) return;
    m.feedback.set(w.id, [...list, { taskId: task.id, body, kind }]);
    store.log(w.id, 'event', t('log.feedbackHeld', { id: task.id, other: other.id }));
    return store.changed();
  }
  if (w.status === 'archived') {
    void restoreWorker(m, w).then((err) => {
      if (err === null) m.sendReview(task, body, kind);
      else store.pushUpdate(`${w.id} could not get its worktree back, so the ${kind === 'ci' ? 'CI failure' : kind === 'conflict' ? 'merge conflict' : 'review comments'} on ${task.id} "${task.title}" (${task.prUrl}) did not reach it.`, true);
    });
    return;
  }
  (kind === 'ci' ? m.ciFixing : m.reviewing).add(task.id);
  store.log(w.id, 'event', t(kind === 'ci' ? 'log.ciFix' : kind === 'conflict' ? 'log.conflictFix' : 'log.review'));
  const msg = kind === 'conflict'
    ? `[Merge conflict] ${task.prUrl} conflicts with its base branch and cannot be merged. Resolve it on the same branch (${task.branch}) and report what you resolved.\n\n${body}`
    : kind === 'ci'
    ? `[CI failure] Checks failed on ${task.prUrl}. Fix them on the same branch (${task.branch}), push, and report what you changed. If a failure does not come from this branch (a flaky test, CI setup, a missing secret), do not change unrelated code; say so in the report.\n\n${body}`
    : `[Review comments] New comments on ${task.prUrl}. Address them on the same branch (${task.branch}), push, and report what you changed. If you leave a comment unaddressed, say why in the report.\n\n${body}`;
  if (!hasSlot(m, w)) return waitForSlot(m, w, task, msg);
  task.status = 'running';
  task.updatedAt = nowIso();
  const s = m.ensureSession(w);
  if (!s) {
    task.status = 'queued';
    task.queueReason = 'limit';
    return hold(m, w, msg);
  }
  deliver(m, w, s, [msg], task);
}

/**
 * PR feedback held while its Worker was on another task (sendReview), sent once that task is settled.
 * All of one task's goes out together; another task's waits until that one is settled in turn.
 */
export function sendFeedback(m: WorkerManager) {
  for (const [id, list] of [...m.feedback]) {
    const w = store.worker(id);
    if (!w) { m.feedback.delete(id); continue; }
    if (m.currentTask(w)) continue;
    const first = list[0].taskId;
    const rest = list.filter((f) => f.taskId !== first);
    if (rest.length) m.feedback.set(id, rest);
    else m.feedback.delete(id);
    const task = store.task(first);
    // Merged, closed or cancelled meanwhile: nothing is left to fix.
    if (task?.status !== 'pr_open') continue;
    for (const f of list) if (f.taskId === first) m.sendReview(task, f.body, f.kind);
  }
}

export function withNotes(m: WorkerManager, w: Worker, msg: string) {
  if (m.restored.delete(w.id)) msg = `[Files restored] The user put the files in your worktree back to an earlier checkpoint. What you remember of them may be out of date: read a file again before you edit it.\n\n${msg}`;
  const ids = m.notes.get(w.id);
  if (!ids?.length) return msg;
  m.notes.delete(w.id);
  return `[Cancelled] The user cancelled ${ids.join(', ')} while it was waiting; do not continue it. The app deleted its branch unless it held commits or uncommitted changes, and may have moved this worktree back to the default branch.\n\n${msg}`;
}

/**
 * A follow-up for a task that finished (or failed) less than 3 days ago reopens that task,
 * so the Worker shows as running on it and its next report settles it.
 */
export function reopenLast(m: WorkerManager, w: Worker): Task | null {
  const last = reopenable(m, w);
  if (!last) return null;
  // A task that failed before finishing just continues; its report is not a follow-up.
  if (last.finishedAt) m.followups.add(last.id);
  setStatus(last, 'running');
  last.stopped = false;
  last.updatedAt = nowIso();
  return last;
}

/** The Worker's last task, when a follow-up would reopen it (reopenLast). */
export function reopenable(m: WorkerManager, w: Worker): Task | null {
  if (m.currentTask(w)) return null;
  const last = w.taskIds.length ? store.task(w.taskIds[w.taskIds.length - 1]) : null;
  return last && canReopen(last) ? last : null;
}
