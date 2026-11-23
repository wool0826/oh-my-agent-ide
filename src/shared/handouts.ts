// Hand-outs in the chat: the "Created W-04" and "Gave … to W-04" lines of one turn fold into one block that
// lists the tasks and where each stands now (T-0043 C1). Main tags those lines (ChatItem.sub 'handout', the task id in
// ref); lines saved before the tag stay single lines.

import type { Task } from './types';

export interface HandoutItem { id: string; kind: string; sub?: string; ref?: string }

/** Where a handed-out task stands, in the words the block counts. */
export type HandoutState = 'ask' | 'run' | 'failed' | 'queued' | 'done' | 'stopped';

export const isHandout = (c: HandoutItem | null | undefined): boolean => c?.kind === 'event' && c.sub === 'handout';

/**
 * The hand-out lines of each turn, by the id of the first line. A turn runs from one message of the user to the next,
 * so replies and results between the lines do not split the block. The other lines of a run are drawn inside the
 * block the first one opens, so the thread skips them (handoutFolded).
 */
export function handoutRuns<T extends HandoutItem>(items: T[]): Map<string, T[]> {
  const runs = new Map<string, T[]>();
  let cur: T[] | null = null;
  for (const c of items) {
    if (c.kind === 'user') { cur = null; continue; }
    if (!isHandout(c)) continue;
    if (cur) cur.push(c);
    else { cur = [c]; runs.set(c.id, cur); }
  }
  return runs;
}

/** The ids of the lines drawn inside a block other than their own. */
export function handoutFolded(runs: Map<string, HandoutItem[]>): Set<string> {
  return new Set([...runs.values()].flatMap((run) => run.slice(1).map((c) => c.id)));
}

/** The tasks a run handed out, in order, each once ("Created" lines name no task). */
export function runTasks(run: HandoutItem[]): string[] {
  return [...new Set(run.map((c) => c.ref).filter((r): r is string => !!r))];
}

/** `asking`: a decision of the task waits for the user. A task the user stopped is not a failure. */
export function handoutState(x: Pick<Task, 'status' | 'stopped'>, asking: boolean): HandoutState {
  if (x.status === 'failed') return x.stopped ? 'stopped' : 'failed';
  if (x.status === 'cancelled') return 'stopped';
  if (asking) return 'ask';
  if (x.status === 'queued' || x.status === 'blocked') return 'queued';
  if (x.status === 'done' || x.status === 'pr_open') return 'done';
  return 'run';
}

/** The order the heading names the states in: what needs the user first. */
export const HANDOUT_ORDER: HandoutState[] = ['ask', 'failed', 'run', 'queued', 'done', 'stopped'];

export function handoutCounts(states: HandoutState[]): [HandoutState, number][] {
  return HANDOUT_ORDER.map((s): [HandoutState, number] => [s, states.filter((x) => x === s).length]).filter(([, n]) => n > 0);
}

/** Nothing left to follow: every task finished or was stopped. A failure keeps the block open. */
export function handoutSettled(states: HandoutState[]): boolean {
  return states.length > 0 && states.every((s) => s === 'done' || s === 'stopped');
}
