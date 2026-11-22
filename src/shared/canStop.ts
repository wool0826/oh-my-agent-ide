// When Stop is offered for a Worker: one rule for the sidebar row, its context menu, the Worker inspector and the
// Worker composer's send button (L3).

import type { Task, Worker } from './types';

/**
 * At work (running, starting, or waiting for the user), or idle with its task open because it waits for the
 * Dispatcher's answer: that task keeps a Worker slot, and Stop ends it.
 */
export function canStop(w: Pick<Worker, 'status' | 'request'>, cur: Pick<Task, 'status'> | null | undefined): boolean {
  if (w.status === 'running' || w.status === 'starting' || w.status === 'waiting') return true;
  return w.status === 'idle' && cur?.status === 'waiting' && !!w.request;
}
