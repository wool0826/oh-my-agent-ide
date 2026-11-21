// The user's open decisions that belong to one Worker: its questions, permission requests and plans.
// The Worker view shows them, and what the user types to that Worker while one is open answers the oldest.
// Shared by the main process (which answers) and the renderer (which shows them).

import type { Decision } from './types';

/** Pending decisions this Worker waits on, oldest first. The Dispatcher's own questions are never a Worker's. */
export function workerDecisions(decisions: Decision[], workerId: string | null | undefined): Decision[] {
  if (!workerId) return [];
  return decisions.filter((d) => d.status === 'pending' && d.workerId === workerId && d.source !== 'dispatcher');
}
