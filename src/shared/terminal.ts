// The side terminal (T-0063): a small panel beside the chat where the user runs lines as with "!", without the
// chat. Its runs are not chat items and are not handed to the Dispatcher; they last until the app quits or Clear.

import type { ShellRun } from './types';

export interface TermRun extends ShellRun { id: string }
export interface TermView { runs: TermRun[] }

export const TERM_EMPTY: TermView = { runs: [] };
/** Runs kept in the panel: the oldest finished ones go first. */
export const TERM_KEEP = 40;
/** Lines kept in the input's history (↑ / ↓). */
export const TERM_HISTORY = 50;

/** Drops the oldest finished runs past `max`; a run still going is never dropped. */
export function trimRuns(runs: TermRun[], max = TERM_KEEP): TermRun[] {
  let over = runs.length - max;
  if (over <= 0) return runs;
  return runs.filter((r) => (over > 0 && !r.running ? (over--, false) : true));
}

/** The history after `line` was run: no repeat of the last one, newest last, at most TERM_HISTORY. */
export function pushHistory(history: readonly string[], line: string): string[] {
  const l = line.trim();
  if (!l || history[history.length - 1] === l) return [...history];
  return [...history, l].slice(-TERM_HISTORY);
}
