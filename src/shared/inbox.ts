// The user's open decisions that belong to one Worker: its questions, permission requests and plans.
// The Worker view shows them; the Worker composer answers a question or a plan only when it says so above the text.
// Shared by the main process (which answers) and the renderer (which shows them).

import type { Decision } from './types';

/** Pending decisions this Worker waits on, oldest first. The Dispatcher's own questions are never a Worker's. */
export function workerDecisions(decisions: Decision[], workerId: string | null | undefined): Decision[] {
  if (!workerId) return [];
  return decisions.filter((d) => d.status === 'pending' && d.workerId === workerId && d.source !== 'dispatcher');
}

/**
 * What the Worker composer answers (M7): the oldest open question or plan, unless the user chose to send a normal
 * message instead. A permission is never answered by typed text; Allow and Deny are its buttons.
 * `asMessage`: the decision ids the user switched to a normal message for.
 */
export function composerAnswers(open: Decision[], asMessage: ReadonlySet<string>): Decision | null {
  return open.find((d) => d.source !== 'permission' && !asMessage.has(d.id)) ?? null;
}

/**
 * The decision a message sent from the Worker composer answers: only the one the composer showed it would answer,
 * still open, of that Worker, and not a permission. Anything else goes to the Worker as a normal message.
 */
export function answerTarget(decisions: Decision[], workerId: string, answerId: string | null | undefined): Decision | null {
  if (!answerId) return null;
  return workerDecisions(decisions, workerId).find((d) => d.id === answerId && d.source !== 'permission') ?? null;
}
