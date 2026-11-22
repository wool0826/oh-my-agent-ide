// The app in the background: what closing the window does, and what the tray icon says (decision 117).

import type { Decision, Task, Worker } from './types';
import { isQueued } from './queue';

export interface TrayCounts {
  /** Decisions waiting for the user. */
  decisions: number;
  /** Workers at work now. */
  running: number;
  /** Tasks waiting for a slot, a usage reset or a merge. */
  queued: number;
}

export function trayCounts(s: { decisions: readonly Pick<Decision, 'status'>[]; workers: readonly Pick<Worker, 'status'>[]; tasks: readonly Task[] }): TrayCounts {
  return {
    decisions: s.decisions.filter((d) => d.status === 'pending').length,
    running: s.workers.filter((w) => w.status === 'running' || w.status === 'starting').length,
    queued: s.tasks.filter((x) => isQueued(x)).length,
  };
}

/**
 * Closing the window hides it when the app is set to keep running; a real quit (the tray's Quit, Cmd+Q,
 * an update, the OS shutting down) always closes it.
 */
export function closeAction(o: { quitting: boolean; background: boolean }): 'hide' | 'close' {
  return !o.quitting && o.background ? 'hide' : 'close';
}

/** The lines of the tray tooltip and menu, most pressing first; `none` when nothing is going on. */
export function trayLines(c: TrayCounts): ('decisions' | 'running' | 'queued' | 'none')[] {
  const out: ('decisions' | 'running' | 'queued')[] = [];
  if (c.decisions) out.push('decisions');
  if (c.running) out.push('running');
  if (c.queued) out.push('queued');
  return out.length ? out : ['none'];
}

/** Started by the OS at sign-in: the window stays hidden until asked for. */
export const HIDDEN_ARG = '--hidden';
