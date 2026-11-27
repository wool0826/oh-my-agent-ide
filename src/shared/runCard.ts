// What the card over a running task in the left sidebar says (renderer/ui/runCard.ts draws it): who runs it and for how
// long, its whole title, every step with the current one marked, what its Worker does now, and its branch and PR.
import { stepView } from './steps';
import type { Task, Worker } from './types';

export type RunCardStep = { title: string; state: 'done' | 'cur' | 'todo' };

export interface RunCard {
  task: string;
  worker: string;
  /** When the task started, for the time it has run. */
  since: string;
  /** In full: the card wraps it, unlike the row. */
  title: string;
  /** The current step (0-based) and how many there are; at equals total once all are done. */
  at: number;
  total: number;
  steps: RunCardStep[];
  /** What the Worker is doing right now (its last tool), what stopped it, or empty. */
  now: string;
  branch: string;
  /** "#212", or empty without a PR. */
  pr: string;
  /** Stopped by an error at the current step; `now` says what it was. */
  err: boolean;
}

const prRef = (url: string | null) => {
  const n = url?.match(/\/pull\/(\d+)/)?.[1];
  return n ? `#${n}` : '';
};

/** `failure` is what stopped the Worker, when an error did. */
export function runCard(x: Task, w: Worker, failure = ''): RunCard {
  const v = stepView(x);
  const at = v?.at ?? 0;
  return {
    task: x.id,
    worker: w.id,
    since: x.startedAt || x.createdAt,
    title: x.title.trim(),
    at,
    total: v?.total ?? 0,
    steps: (x.steps ?? []).map((s, i) => ({ title: s.title, state: s.doneAt ? 'done' : i === at ? 'cur' : 'todo' })),
    now: (failure || w.statusText).trim(),
    branch: x.branch ?? '',
    pr: prRef(x.prUrl),
    err: !!failure,
  };
}
