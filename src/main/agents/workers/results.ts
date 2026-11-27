import { listCheckpoints, restoreCheckpoint, saveCheckpoint } from '../../checkpoints';
import { worktreeDiff } from '../../gitdiff';
import { changedFiles } from '../../gitwork';
import { t } from '../../i18n';
import { log } from '../../log';
import { remember } from '../../memory';
import { notifyTaskEnd } from '../../notify';
import { store } from '../../store';
import { nowIso, oneLine } from '../../util';
import { needsPlan, parseResult } from '../workerPrompt';
import { ownsPr, pickTaskPr } from '../../../shared/prOwner';
import { GO_ON_MSG, clip, noResultMsg } from '../workerText';
import type { WorkerManager } from '../workers';
import { checkpointLabel } from '../../../shared/checkpoints';
import { mergeLinks } from '../../../shared/linkify';
import { isLocalRepo } from '../../../shared/localRepo';
import { doneNotice } from '../../../shared/notifyRules';
import { hasSpend, spendVars } from '../../../shared/spend';
import { setStatus } from '../../../shared/taskStatus';
import { openWork, turnOutcome } from '../../../shared/turnOutcome';
import type { Task, Worker } from '../../../shared/types';
import { awaitPlan } from './plans';
import { awaitDispatcher, unanswered } from './questions';
import { followUp } from './queue';

/**
 * A turn ended. What it said goes to the Dispatcher when the Dispatcher waits for it, and its open task (if any)
 * is finished only when the turn says so: not while subagents still run, and not while the Worker waits for the
 * Dispatcher.
 */
export function turnEnded(m: WorkerManager, w: Worker, text: string, isError: boolean, background: boolean) {
  const task = m.currentTask(w);
  const owed = m.replyOwed.delete(w.id);
  const questioned = m.questioned.delete(w.id);
  const said = !isError && !!text.trim();
  // The turn that read a question closes it. An answer in plain text, without tell_dispatcher, still reaches the Dispatcher.
  if (said && w.ask) m.fromWorker(w, 'answer', text, true);
  else if (w.ask) unanswered(m, w, isError ? text : '', true);
  // A reply to instructions with no task to report on. It needs no turn of the Dispatcher's own.
  else if (said && owed && !task) store.pushUpdate(`${w.id} replied to your message: ${clip(text, 1000)}`);
  if (!task) return;
  // A plan-first task is not done before its plan is approved.
  if (needsPlan(task) && !isError) return awaitPlan(m, w, task, text, background);
  if (!isError) {
    const { reported, blocked } = parseResult(text, w.cwd);
    const s = m.sessions.get(w.id);
    const live = !!s && !s.closed;
    const how = turnOutcome({
      reported, blocked: !!blocked || !!w.request, background, said, questioned,
      reminded: m.resultReminded.has(task.id) || !live, openWork: openWork(task),
    });
    // Subagents the turn started are still running, or the turn said nothing (one Claude Code ends for a notice,
    // such as a background shell the last session left behind): the task stays open, and sweepStalled reminds the
    // Worker if nothing goes on.
    if (how === 'wait') { task.updatedAt = nowIso(); return store.changed(); }
    if (how === 'ask') return awaitDispatcher(m, w, task, blocked);
    // It stopped after a question (answered with the tool or in plain text), so the turn may have said nothing
    // about the task: it is told to go on, once. That message asks for the RESULT lines too, so it is the one reminder.
    if (how === 'goOn' && live) {
      m.resultReminded.add(task.id);
      s!.send(GO_ON_MSG);
      return m.touch(w);
    }
    if (how === 'remind') {
      m.resultReminded.add(task.id);
      log.info(`[${w.id}] ${task.id}: turn ended without RESULT; reminded`);
      s!.send(noResultMsg(task.id));
      return m.touch(w);
    }
  }
  finalize(m, w, task, text, isError);
}

export function finalize(m: WorkerManager, w: Worker, task: Task, text: string, isError: boolean) {
  if (isError) return fail(m, w, task, text);
  const repo = task.repo ? store.repo(task.repo) : null;
  // Only a PR of the task's own repository is its PR; other URLs in the report are links (T-0150).
  const parsed = parseResult(text, w.cwd, (urls) => pickTaskPr(urls, task, repo));
  // A local-only repository has no PR: the result is the branch the work is on, which the user merges.
  const local = task.kind === 'code' && isLocalRepo(repo) && !!task.branch;
  const prUrl = local ? null : parsed.prUrl;
  const summary = local ? `${parsed.summary} ${t('res.localBranch', { branch: task.branch!, base: repo!.defaultBranch })}` : parsed.summary;
  const { files } = parsed;
  task.updatedAt = nowIso();
  const wasReview = m.reviewing.delete(task.id);
  const wasCi = m.ciFixing.delete(task.id);
  const wasFollowup = m.followups.delete(task.id);
  const firstFinish = !task.finishedAt;
  m.resultReminded.delete(task.id);
  m.branchChecked.delete(task.id);
  // Finished anyway: what it asked the Dispatcher for holds nothing up any more.
  w.request = null;
  m.requestWakes.delete(task.id);
  task.summary = summary;
  task.prUrl = prUrl ?? task.prUrl;
  if (!ownsPr(task, repo)) task.prUrl = null;
  task.files = files.length ? files : task.files;
  // Links add up over the task's turns, once each and without its own PR ("[title](url)" is matched by its URL).
  const own = prUrl ?? task.prUrl;
  if (parsed.links.length) task.links = mergeLinks(task.links, parsed.links, own);
  setStatus(task, task.prUrl ? 'pr_open' : 'done');
  task.stopped = false;
  task.prState = task.prUrl ? (task.prState ?? 'OPEN') : null;
  task.finishedAt = nowIso();
  if (task.prUrl && !task.reviewSyncedAt) task.reviewSyncedAt = nowIso();
  const label = wasReview ? t('res.reviewLabel') : wasCi ? t('res.ciFixLabel') : wasFollowup ? t('res.followupLabel') : t('res.doneLabel');
  store.chat('result', wasReview ? t('res.review', { s: summary }) : wasCi ? t('res.ciFix', { s: summary }) : wasFollowup ? t('res.followup', { s: summary }) : summary, task.id);
  store.pushUpdate(`${w.id} ${task.id} "${task.title}" ${wasReview ? 'review fixed' : wasCi ? 'CI fixed' : wasFollowup ? 'follow-up done' : 'done'}: ${summary}${task.prUrl ? ` (PR ${task.prUrl})` : ''}${task.files.length ? `, ${task.files.length} file(s)` : ''}${task.links?.length ? `. Links: ${task.links.join(' ')}` : ''}`, true, task.id);
  if (firstFinish) remember('task', `${task.id} ${task.title} (${w.id}${w.repo ? `, ${w.repo}` : ''}) ${summary}${task.prUrl ? ` ${task.prUrl}` : ''}${task.links?.length ? ` ${task.links.join(' ')}` : ''}${hasSpend(task.spend) ? ` · ${t('spend.memo', spendVars(task.spend))}` : ''}`);
  const n = doneNotice(t, { who: w.id, title: task.title, summary, ok: true, label, code: task.kind === 'code', prUrl: task.prUrl });
  notifyTaskEnd(n.title, n.body, w.id, task.id);
  followUp(m, task);
  store.changed();
  m.fillSlots();
}

export function fail(m: WorkerManager, w: Worker, task: Task, text: string) {
  const by = m.stopping.get(w.id);
  const stopped = !!by;
  setStatus(task, 'failed');
  task.stopped = stopped;
  task.updatedAt = nowIso();
  task.summary = stopped ? t(by === 'user' ? 'task.stoppedUser' : 'task.stoppedDispatcher') : oneLine(text || t('err.stopped'), 200);
  w.request = null;
  m.requestWakes.delete(task.id);
  if (stopped) {
    // A result, not an error: the user meant it. The Dispatcher hears it without a turn of its own.
    store.chat('result', t(by === 'user' ? 'ev.stopped' : 'ev.stoppedDispatcher', { id: w.id }), task.id);
    store.log(w.id, 'event', t(by === 'user' ? 'log.stopped' : 'log.stoppedDispatcher'));
    if (by === 'user') store.pushUpdate(`The user stopped ${w.id} on ${task.id} "${task.title}". The task is left unfinished; a message to ${w.id} continues it.`);
  } else {
    store.event(t('ev.failed', { id: w.id, title: task.title, msg: task.summary }), { k: 'failed', task: task.id, worker: w.id, title: task.title }, { kind: 'error', ref: task.id });
    store.pushUpdate(`${w.id} ${task.id} "${task.title}" failed: ${task.summary}`, true, task.id);
    const n = doneNotice(t, { who: w.id, title: task.title, summary: task.summary, ok: false, prUrl: task.prUrl });
    // Its own burst: a failure right after another end of this Worker is not swallowed.
    notifyTaskEnd(n.title, n.body, `${w.id}:failed`, task.id);
  }
  followUp(m, task);
  m.fillSlots();
}

/**
 * Record on the task whose branch the Worker's worktree has checked out which files that branch changes, so a new
 * task naming one of them is flagged (shared/overlap.ts). Read from git each time a turn ends; a later read wins.
 * Detached with the task in progress's branch never made (a fake Worker), the files are that task's, taken before
 * the turn settles it. Detached otherwise (mid-rebase, back at the base) nothing is recorded.
 */
export async function recordChanged(m: WorkerManager, w: Worker) {
  const repo = w.repo ? store.repo(w.repo) : null;
  if (!repo) return;
  const seq = (m.changedSeq.get(w.id) ?? 0) + 1;
  m.changedSeq.set(w.id, seq);
  const cur = m.currentTask(w);
  const r = await changedFiles(w.cwd, repo.defaultBranch, isLocalRepo(repo), cur?.kind === 'code' ? cur.branch : null).catch(() => null);
  if (!r || m.changedSeq.get(w.id) !== seq) return;
  const task = r.branch ? w.taskIds.map((id) => store.task(id)).find((x) => x?.kind === 'code' && x.branch === r.branch)
    : cur?.kind === 'code' && !r.hintExists ? cur : null;
  if (!task || task.status === 'cancelled' || !store.task(task.id) || task.changedFiles?.join('\0') === r.files.join('\0')) return;
  task.changedFiles = r.files;
  store.changed();
}

/**
 * Save a repository Worker's files before it is handed something, named after it. Not waited for: git finishes
 * long before the agent's first edit, and a message must not wait on it. Equal states are saved once.
 */
export function checkpoint(m: WorkerManager, w: Worker, about: string) {
  if (!w.repo) return;
  void saveCheckpoint(w.cwd, w.id, checkpointLabel(about)).catch((e) => log.warn('checkpoint failed', (e as Error).message));
}

export function checkpoints(m: WorkerManager, workerId: string) {
  const w = store.worker(workerId);
  return w?.repo ? listCheckpoints(w.cwd, w.id) : Promise.resolve([]);
}

/** Put a Worker's files back to a checkpoint. Not while it works: the agent would be editing the same files. */
export async function restore(m: WorkerManager, workerId: string, ref: string) {
  const w = store.worker(workerId);
  if (!w?.repo) throw new Error(t('ckpt.err.none'));
  if (w.status === 'running' || w.status === 'starting') throw new Error(t('ckpt.err.busy'));
  await restoreCheckpoint(w.cwd, w.id, ref);
  store.log(w.id, 'event', t('log.restored'));
  // The agent still remembers the files as it left them: its next message says they changed under it.
  m.restored.add(w.id);
  store.changed();
}

export async function diff(m: WorkerManager, workerId: string) {
  const w = store.worker(workerId);
  const repo = w?.repo ? store.repo(w.repo) : null;
  if (!w || !repo) return null;
  return worktreeDiff(repo.defaultBranch, w.cwd, isLocalRepo(repo));
}
