/* eslint-disable @typescript-eslint/no-explicit-any -- AskUserQuestion input is whatever the model sent, read field by field. */
import { ask } from '../../decisions';
import { t } from '../../i18n';
import { store } from '../../store';
import { nowIso, oneLine, uid } from '../../util';
import { adviseOnQuestion } from '../advisor';
import { MAX_REQUEST_WAKES, REPLY_NOTE, TellKind, clip, question } from '../workerText';
import type { WorkerManager } from '../workers';
import { questionReason } from '../../../shared/askWhy';
import { setStatus } from '../../../shared/taskStatus';
import type { Task, Worker } from '../../../shared/types';
import { post } from './messages';
import { awaitDecision, decided } from './permissions';

export async function answerQuestions(m: WorkerManager, w: Worker, input: Record<string, unknown>, signal: AbortSignal) {
  const questions = (input.questions as any[]) ?? [];
  const answers: Record<string, string> = {};
  const task = m.currentTask(w);
  for (const q of questions) {
    const opts: string[] = (q.options ?? []).map((o: any) => String(o.label));
    store.log(w.id, 'worker', `${t('log.question')}: ${q.question}${opts.length ? `\n${t('log.options')}: ${opts.join(' / ')}` : ''}`);
    const verdict = await adviseOnQuestion({ workerId: w.id, taskTitle: task?.title ?? w.title, question: q.question, options: opts });
    if (verdict?.canAnswer) {
      answers[q.question] = verdict.answer;
      const aa = { id: uid(), workerId: w.id, question: q.question, answer: verdict.answer, basis: verdict.basis, createdAt: nowIso(), corrected: null, cleared: false };
      store.data.autoAnswers.push(aa);
      store.chat('auto', t('ev.autoAnswered', { id: w.id, q: q.question, a: verdict.answer, basis: verdict.basis }), aa.id);
      store.log(w.id, 'auto', t('log.autoAnswered', { a: verdict.answer, basis: verdict.basis }));
      continue;
    }
    const prev = awaitDecision(m, w, task);
    try {
      const ans = await ask({
        source: 'question', workerId: w.id, taskId: task?.id ?? null,
        title: q.question, detail: task ? task.title : w.title, code: null,
        options: (q.options ?? []).map((o: any) => ({ label: String(o.label), description: o.description ? String(o.description) : undefined })),
        questionKey: q.question,
        reason: questionReason(t, { who: w.id, task, advisor: verdict?.basis }),
      }, signal);
      answers[q.question] = ans;
      store.log(w.id, 'user', `${t('log.answer')}: ${ans}`);
    } catch {
      answers[q.question] = '(The user did not answer. Decide sensibly, proceed, and mention it in your report.)';
    } finally {
      decided(m, w, task, prev);
    }
  }
  return { behavior: 'allow' as const, updatedInput: { ...input, answers } };
}

/**
 * What a Worker tells the Dispatcher with tell_dispatcher. An answer to an open question and a request start
 * a Dispatcher turn; a note, or an answer nobody asked for, waits for its next one.
 * spoken: it was the text of the Worker's turn, which its conversation shows already. Returns the tool's reply.
 */
export function fromWorker(m: WorkerManager, w: Worker, kind: TellKind, text: string, spoken = false): string {
  const body = text.trim();
  if (!body) return 'Nothing was sent: the text is empty.';
  if (!spoken) store.log(w.id, 'worker', `${t('log.toDispatcher')}: ${body}`);
  const task = m.currentTask(w);
  if (kind === 'answer' && w.ask) {
    const asked = w.ask.text;
    w.ask = null;
    store.event(t('ev.answered', { id: w.id, text: oneLine(body, 200) }), { k: 'answered', worker: w.id, task: task?.id, title: oneLine(body, 200) });
    store.pushUpdate(`${w.id} answered your question "${oneLine(asked, 200)}": ${clip(body, 4000)}`, true);
    return 'Delivered to the Dispatcher. Go on with what you were doing.';
  }
  if (kind === 'request') {
    raise(m, w, task, body);
    return 'Delivered. The answer comes as a "[Dispatcher]" message. Go on with what does not depend on it; if nothing is left, end your turn with "BLOCKED: what you need".';
  }
  store.pushUpdate(`${w.id}${task ? ` (${task.id})` : ''} notes: ${clip(body, 1000)}`);
  return 'Noted. The Dispatcher reads it on its next turn.';
}

/** Tell the Dispatcher what a Worker needs from it. Past the cap for one task, it waits for the Dispatcher's next turn. */
export function raise(m: WorkerManager, w: Worker, task: Task | null, text: string, blocked = false) {
  const wake = wakesLeft(m, task?.id ?? w.id);
  w.request = { text, at: nowIso() };
  const about = task ? ` (${task.id} "${task.title}")` : '';
  store.event(t(blocked ? 'ev.blocked' : 'ev.requested', { id: w.id, text: oneLine(text, 200) }), { k: blocked ? 'blocked' : 'request', worker: w.id, task: task?.id, title: oneLine(text, 200) }, { ref: task?.id });
  store.pushUpdate(blocked
    ? `${w.id}${about} is blocked and waits for you: ${clip(text, 4000)}\n  ${REPLY_NOTE}`
    : `${w.id}${about} asks you: ${clip(text, 4000)}\n  Reply with send_to_worker: the answer, or what you did about it.`, wake);
}

/** A question got no answer: the turn that read it failed or was stopped, or the app restarted first. */
export function unanswered(m: WorkerManager, w: Worker, why: string, wake: boolean) {
  const asked = w.ask?.text ?? '';
  w.ask = null;
  store.pushUpdate(`${w.id} did not answer your question "${oneLine(asked, 200)}"${why ? ` (${oneLine(why, 200)})` : ''}. Ask again if you still need the answer.`, wake);
}

/** Counts one more thing a Worker needs from the Dispatcher; past the cap for one task (or one Worker without a task) it starts no turn. */
export function wakesLeft(m: WorkerManager, key: string) {
  const n = (m.requestWakes.get(key) ?? 0) + 1;
  m.requestWakes.set(key, n);
  return n <= MAX_REQUEST_WAKES;
}

/**
 * The turn ended with the task unfinished because the Worker needs the Dispatcher. The task stays open and keeps
 * its slot, like any task that waits for an answer, and goes on with the next message to the Worker.
 */
export function awaitDispatcher(m: WorkerManager, w: Worker, task: Task, need: string | null) {
  setStatus(task, 'waiting', 'dispatcher');
  task.updatedAt = nowIso();
  // A BLOCKED report without a request is the request. One made earlier told the Dispatcher what is needed; now
  // it hears that the task stopped for it, in case it did something about the request without writing back.
  if (!w.request) raise(m, w, task, need ?? '', true);
  else store.pushUpdate(`${w.id} (${task.id} "${task.title}") stopped and waits for your reply to what it asked: ${oneLine(w.request.text, 300)}\n  ${REPLY_NOTE}`, wakesLeft(m, task.id));
  w.statusText = t('st.awaitDispatcher');
  store.changed();
}

/**
 * The Dispatcher asks a Worker something. Unlike instructions, a question reopens no task, and the answer goes
 * back to the Dispatcher: by tell_dispatcher, mid-task too, or as the text of the turn. Says where the question is now.
 */
export async function askWorker(m: WorkerManager, workerId: string, text: string) {
  const w = store.worker(workerId);
  if (!w) throw new Error(t('err.noWorker', { id: workerId }));
  if (w.status === 'archived') await m.unarchive(w);
  store.log(w.id, 'dispatcher', `${t('log.question')}: ${text}`);
  store.event(t('ev.asked', { id: w.id, text: oneLine(text, 200) }), { k: 'asked', worker: w.id, task: m.currentTask(w)?.id, title: oneLine(text, 200) });
  // Questions asked before an answer came are answered together.
  w.ask = { text: w.ask ? `${w.ask.text}\n${text}` : text, at: w.ask?.at ?? nowIso() };
  m.questioned.add(w.id);
  return post(m, w, question(text));
}
