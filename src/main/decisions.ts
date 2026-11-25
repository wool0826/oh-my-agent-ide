import { store } from './store';
import { nowIso, uid } from './util';
import type { Decision } from '../shared/types';
import { withPermission } from '../shared/retro';

type Waiter = (answer: string) => void;
const waiters = new Map<string, Waiter>();
let onNew: (d: Decision) => void = () => {};
let onLate: (d: Decision) => void = () => {};

export function onDecisionCreated(fn: (d: Decision) => void) { onNew = fn; }
/** An answer arrived for a decision whose waiter is gone (the app restarted). */
export function onLateAnswer(fn: (d: Decision) => void) { onLate = fn; }

export function createDecision(d: Omit<Decision, 'id' | 'status' | 'answer' | 'createdAt' | 'answeredAt'>): Decision {
  const dec: Decision = { ...d, id: uid(), status: 'pending', answer: null, createdAt: nowIso(), answeredAt: null };
  store.data.decisions.push(dec);
  store.changed();
  onNew(dec);
  return dec;
}

/** Create a decision and wait for the answer. If the signal aborts, withdraw it; one aborted already asks nothing. */
export function ask(d: Omit<Decision, 'id' | 'status' | 'answer' | 'createdAt' | 'answeredAt'>, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) return Promise.reject(new Error('aborted'));
  return waitFor(createDecision(d).id, signal);
}

/** Wait for the answer to a pending decision, such as one kept over a restart. If the signal aborts, withdraw it. */
export function waitFor(id: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const gone = () => {
      waiters.delete(id);
      withdraw(id);
      reject(new Error('aborted'));
    };
    if (signal?.aborted) return gone();
    waiters.set(id, resolve);
    signal?.addEventListener('abort', gone, { once: true });
  });
}

export function answer(id: string, ans: string) {
  const d = store.data.decisions.find((x) => x.id === id);
  if (!d || d.status !== 'pending') return null;
  d.status = 'answered';
  d.answer = ans;
  d.answeredAt = nowIso();
  // Answered decisions go after a day; the task keeps its permission decisions for the look back.
  const task = d.source === 'permission' && d.taskId ? store.task(d.taskId) : null;
  if (task) task.permissions = withPermission(task.permissions, { at: d.createdAt, answeredAt: d.answeredAt, code: d.code ?? d.title, answer: ans });
  store.changed();
  const w = waiters.get(id);
  waiters.delete(id);
  if (w) w(ans);
  else onLate(d);
  return d;
}

export function withdraw(id: string) {
  const i = store.data.decisions.findIndex((x) => x.id === id && x.status === 'pending');
  if (i >= 0) {
    store.data.decisions.splice(i, 1);
    store.changed();
  }
}

/** Drop answered decisions after a day (the chat and memory keep the record). */
export function pruneDecisions() {
  const cutoff = Date.now() - 24 * 3600_000;
  const before = store.data.decisions.length;
  store.data.decisions = store.data.decisions.filter((d) => d.status === 'pending' || Date.parse(d.answeredAt ?? d.createdAt) > cutoff);
  if (store.data.decisions.length !== before) store.changed();
}
