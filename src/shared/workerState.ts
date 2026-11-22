// What a Worker is doing, in one word and one sentence: the Worker list's pill and second line, the sidebar's
// "Stopped with an error" and the chat's failure card read it from here. Built only from the app state.

import type { Say } from './askWhy';
import { shownStalled } from './stall';
import { stepView, type StepView } from './steps';
import type { Decision, Task, Worker } from './types';

/**
 * ask: waits for the user. asked: waits for the Dispatcher's answer. failed: stopped by an error.
 * stopped: the user or the Dispatcher pressed Stop. queued: its task waits for a slot, a limit or a merge.
 * stalled: its task is open but nothing runs it (shared/stall.ts).
 */
export type WorkerState = 'ask' | 'run' | 'stalled' | 'failed' | 'asked' | 'queued' | 'pr' | 'done' | 'stopped' | 'idle' | 'archived';

type W = Pick<Worker, 'status' | 'statusText' | 'request' | 'stalledAt'>;
type T = Pick<Task, 'status' | 'stopped' | 'summary' | 'steps'>;

/**
 * Stopped by an error. A failed turn fails its task and leaves the Worker idle (only a lost session sets the status
 * `error`), so the last task says it too. It holds until the Worker is told to go on or gets another task.
 */
export function lastFailed(w: Pick<Worker, 'status'>, last: Pick<Task, 'status' | 'stopped'> | null | undefined): boolean {
  if (w.status === 'error') return true;
  return w.status === 'idle' && last?.status === 'failed' && !last.stopped;
}

export function workerState(w: Pick<Worker, 'status' | 'request' | 'stalledAt'>, last: Pick<Task, 'status' | 'stopped'> | null | undefined): WorkerState {
  if (w.status === 'archived') return 'archived';
  if (w.status === 'running' || w.status === 'starting') return 'run';
  if (w.status === 'waiting') return 'ask';
  if (shownStalled(w)) return 'stalled';
  if (lastFailed(w, last)) return 'failed';
  if (last?.status === 'waiting' && w.request) return 'asked';
  if (last?.status === 'queued' || last?.status === 'blocked') return 'queued';
  if (last?.status === 'pr_open') return 'pr';
  if (last?.status === 'done') return 'done';
  if (last?.status === 'failed') return 'stopped';
  return 'idle';
}

const PROTOCOL = /^(RESULT|PR|FILE|BLOCKED):/;

/**
 * A Worker's last words without the report protocol: "PR: https://… RESULT: Added the export" reads
 * "Added the export". Text that is no report is returned as it is, on one line.
 */
export function plainStatus(text: string | null | undefined): string {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!PROTOCOL.test(s)) return s;
  const said = s.match(/(?:^|\s)(?:RESULT|BLOCKED):\s*(.*?)(?=\s(?:RESULT|PR|FILE|BLOCKED):|$)/);
  if (said?.[1]) return said[1].trim();
  return s.replace(/(?:^|\s)(?:RESULT|PR|FILE|BLOCKED):\s*\S*/g, '').trim();
}

/**
 * What a pending decision asks, in one line: a plan's WHAT, a command with the command itself ("Run this command?
 * npm install x"), or the question.
 */
export function askLine(d: Pick<Decision, 'source' | 'title' | 'code' | 'summary'>): string {
  if (d.summary?.what) return d.summary.what;
  const code = d.source === 'permission' ? String(d.code ?? '').replace(/\s+/g, ' ').trim() : '';
  return code ? `${d.title} ${code}` : d.title;
}

export interface WorkerLine {
  /** The most useful sentence for the state; empty when there is nothing to say. */
  text: string;
  /** The plan to draw as pips before the text: while it runs, waits or stopped part-way. */
  steps: StepView | null;
}

/**
 * The second line of a Worker's row. `ask`: what it asks the user. `queue`: why its task waits (queueLine).
 * `about`: what to show when the state has no news (its repository and model).
 */
export function workerLine(say: Say, w: W, last: T | null | undefined, o: { ask?: string | null; queue?: string | null; about?: string }): WorkerLine {
  const state = workerState(w, last);
  const v = stepView(last);
  const now = plainStatus(w.statusText);
  switch (state) {
    case 'ask': return { text: o.ask || say('st.waitingMe'), steps: v };
    case 'run': {
      if (v && !v.allDone) return { text: `${v.at + 1}/${v.total} · ${v.current}`, steps: v };
      return { text: now || say('st.running'), steps: v };
    }
    // Stalled part-way: the step it sits on, without the count a running Worker leads with.
    case 'stalled': return { text: v && !v.allDone ? `${v.at + 1}/${v.total} · ${v.current}` : now || o.about || '', steps: v };
    case 'failed': {
      const why = plainStatus(w.status === 'error' ? w.statusText || last?.summary : last?.summary);
      const at = v && !v.allDone ? say('wk.stoppedAt', { n: v.at + 1, total: v.total }) : '';
      return { text: [at, why].filter(Boolean).join(' · ') || say('st.failed'), steps: v && !v.allDone ? v : null };
    }
    case 'asked': return { text: plainStatus(w.request?.text) || say('st.awaitDispatcher'), steps: v };
    case 'queued': return { text: o.queue || now, steps: null };
    case 'pr': case 'done': case 'stopped': return { text: plainStatus(last?.summary) || o.about || '', steps: null };
    default: return { text: o.about ?? '', steps: null };
  }
}

/** How many Workers are in each state the list's heading counts; archived ones are left out. */
export function stateCounts(states: WorkerState[]) {
  const n = (...of: WorkerState[]) => states.filter((s) => of.includes(s)).length;
  return { ask: n('ask'), run: n('run'), failed: n('failed'), stalled: n('stalled'), queued: n('queued', 'asked'), done: n('pr', 'done') };
}
