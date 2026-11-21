// Why a queued or blocked task waits, and what starts it, in one short sentence each.
// The Worker view's "Waiting" card and the sidebar queue row's tooltip show it. Built only from the app state.

import { taskRef, type Say } from './askWhy';
import { afterDependency, hasOpenPr, isQueued } from './queue';
import { queueOrder, slotsUsed, waitsForSlot } from './slots';
import type { AccountView, Task } from './types';

export interface QueueCtx {
  tasks: Task[];
  accounts: Pick<AccountView, 'label' | 'limitedUntil'>[];
  maxWorkers: number;
  /** Formats a reset time for the reader (the renderer's clock time). */
  time: (ms: number) => string;
  now?: number;
}

export interface QueueWhy {
  /** Why it waits. */
  why: string;
  /** What starts it. */
  starts: string;
  /** It will never start: the task it waits for failed, was cancelled, or its PR was closed (decision 92). */
  cancelled: boolean;
  /** It finished once and was queued again (review or CI fixes, a follow-up): what cancelling keeps. */
  again: string | null;
}

/** Its place among the tasks waiting for a slot, the longest waiting first; null when it does not wait for one. */
export function queuePlace(tasks: Task[], id: string): { pos: number; total: number } | null {
  const line = queueOrder(tasks, 'slot');
  const i = line.findIndex((x) => x.id === id);
  return i < 0 ? null : { pos: i + 1, total: line.length };
}

const prNo = (url: string | null) => url?.match(/\/pull\/(\d+)/)?.[1] ?? '';

/** Null for a task that does not wait in the queue. */
export function queueWhy(say: Say, task: Task, ctx: QueueCtx): QueueWhy | null {
  if (!isQueued(task)) return null;
  const now = ctx.now ?? Date.now();
  const again = task.finishedAt
    ? hasOpenPr(task) ? say('q.againPr', { n: prNo(task.prUrl) }) : say('q.again')
    : null;

  if (task.status === 'blocked') {
    const depId = task.afterTaskId ?? '';
    const dep = ctx.tasks.find((x) => x.id === depId) ?? null;
    const why = say('q.afterWhy', { dep: dep ? taskRef(dep) : depId });
    const cancelled = (starts: string) => ({ why, starts, cancelled: true, again });
    const next = afterDependency(dep);
    if (next === 'cancel') return cancelled(say('q.afterCancel', { id: dep?.id ?? depId }));
    if (next === 'start') return { why, starts: dep?.prUrl ? say('q.afterMerged', { n: prNo(dep.prUrl) }) : say('q.afterDone', { id: depId }), cancelled: false, again };
    if (dep && hasOpenPr(dep)) return { why, starts: say('q.afterPr', { n: prNo(dep.prUrl) }), cancelled: false, again };
    return { why, starts: say('q.afterNoPr', { id: depId }), cancelled: false, again };
  }

  if (waitsForSlot(task)) {
    const n = slotsUsed(ctx.tasks);
    const why = say('q.slotWhy', { n, max: ctx.maxWorkers });
    if (n < ctx.maxWorkers) return { why, starts: say('q.slotFree'), cancelled: false, again };
    const place = queuePlace(ctx.tasks, task.id) ?? { pos: 1, total: 1 };
    return { why, starts: say('q.slotStarts', place), cancelled: false, again };
  }

  // Paused for a usage limit: it goes on when the first account's limit resets.
  const why = say('q.limitWhy');
  // The same rule as nextFreeAt (shared/usage.ts): only when every account is held does it wait.
  const ends = ctx.accounts.map((a) => (a.limitedUntil ? Date.parse(a.limitedUntil) : 0));
  if (!ends.length || ends.some((e) => !(e > now))) return { why, starts: say('q.limitReset'), cancelled: false, again };
  const at = Math.min(...ends);
  const first = ctx.accounts[ends.indexOf(at)];
  return { why, starts: say('q.limitStarts', { account: first.label, time: ctx.time(at) }), cancelled: false, again };
}

/** Both sentences on one line, for a tooltip. */
export function queueWhyText(q: QueueWhy): string {
  return [q.why, q.starts, q.again].filter(Boolean).join(' ');
}
