// What a Worker's turn that ended means for its open task (T-0136). Only a RESULT line finishes it for sure: a turn
// that said nothing is no report (Claude Code ends one for a notice, such as a background shell that died with the
// session before a usage limit), and a turn that said something else gets one reminder first.
import type { Task } from './types';
import { hasOpenPr } from './queue';

/**
 * finish: settle the task with what the turn said.
 * wait: leave it open; the session goes on by itself, or sweepStalled reminds the Worker later.
 * ask: the Worker waits for the Dispatcher (BLOCKED, or a request still open).
 * goOn: it stopped after a question; tell it to go on.
 * remind: it stopped without RESULT; ask it once to report, or to go on.
 */
export type TurnOutcome = 'finish' | 'wait' | 'ask' | 'goOn' | 'remind';

export interface TurnEnd {
  /** The turn wrote a RESULT line. */
  reported: boolean;
  /** It wrote BLOCKED, or a request to the Dispatcher is still open. */
  blocked: boolean;
  /** Subagents or shells it started still run. */
  background: boolean;
  /** It wrote any text at all. */
  said: boolean;
  /** It read a question from the Dispatcher. */
  questioned: boolean;
  /** The Worker was already reminded once on this task that a turn ended without RESULT. */
  reminded: boolean;
  /** Something of the task is still open: a step not done, or a PR not merged (openWork). */
  openWork: boolean;
}

export function turnOutcome(t: TurnEnd): TurnOutcome {
  if (t.reported) return 'finish';
  if (t.background) return 'wait';
  if (t.blocked) return 'ask';
  if (t.questioned) return 'goOn';
  if (!t.said) return 'wait';
  if (!t.reminded) return 'remind';
  // It was told and still wrote no RESULT: finished, unless it left work open.
  return t.openWork ? 'wait' : 'finish';
}

/** A task with a planned step not done yet, or a PR that is not merged or closed. */
export function openWork(task: Pick<Task, 'steps' | 'prUrl' | 'prState'>): boolean {
  return !!task.steps?.some((s) => !s.doneAt) || hasOpenPr(task);
}
