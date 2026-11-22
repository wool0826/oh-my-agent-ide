// Why a queued or blocked task waits, and what starts it, in one short sentence each.
// The Worker view's "Waiting" card and the sidebar queue row's tooltip show it; the row itself and the Worker list
// show the short form (queueLine). Built only from the app state.

import { taskRef, type Say } from './askWhy';
import { afterDependency, hasOpenPr, isQueued } from './queue';
import { canStart, queueOrder, slotsUsed, waitsForSlot } from './slots';
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
    // The same test fillSlots makes picks both sentences: its Worker already holds a slot, or one is free.
    if (canStart(ctx.tasks, task.workerId ?? task.id, ctx.maxWorkers)) return { why: say('q.slotFreeWhy', { n, max: ctx.maxWorkers }), starts: say('q.slotFree'), cancelled: false, again };
    const place = queuePlace(ctx.tasks, task.id) ?? { pos: 1, total: 1 };
    return { why: say('q.slotWhy', { n, max: ctx.maxWorkers }), starts: say('q.slotStarts', place), cancelled: false, again };
  }

  // Paused for a usage limit: it goes on when the first account's limit resets.
  const why = say('q.limitWhy');
  // The same rule as nextFreeAt (shared/usage.ts): only when every account is held does it wait.
  const ends = ctx.accounts.map((a) => (a.limitedUntil ? Date.parse(a.limitedUntil) : 0));
  if (!ends.length || ends.some((e) => !(e > now))) {
    // Going on needs a slot like any other resume (workers.ts retryQueued).
    const slot = canStart(ctx.tasks, task.workerId ?? task.id, ctx.maxWorkers);
    return { why, starts: say(slot ? 'q.limitReset' : 'q.limitResetSlot', { max: ctx.maxWorkers }), cancelled: false, again };
  }
  const at = Math.min(...ends);
  const first = ctx.accounts[ends.indexOf(at)];
  return { why, starts: say('q.limitStarts', { account: first.label, time: ctx.time(at) }), cancelled: false, again };
}

/** Both sentences on one line, for a tooltip. */
export function queueWhyText(q: QueueWhy): string {
  return [q.why, q.starts, q.again].filter(Boolean).join(' ');
}

export interface QueueLine {
  /** Its place among the tasks waiting for a slot (1 is next); null when something else holds it (a merge, a usage limit). */
  pos: number | null;
  /** What starts it, in a few words: "next, when a slot frees", "starts when PR #7 merges". */
  text: string;
  /** It will never start (decision 92). */
  cancelled: boolean;
}

/** English ordinals for the place in line: 2nd, 3rd, 11th. */
export function ordinal(n: number): string {
  const t = n % 100;
  const s = t >= 11 && t <= 13 ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th';
  return `${n}${s}`;
}

/** The queue row's second line and its place number. Null for a task that does not wait in the queue. */
export function queueLine(say: Say, task: Task, ctx: QueueCtx): QueueLine | null {
  if (!isQueued(task)) return null;
  const now = ctx.now ?? Date.now();
  const soon = (pos: number | null): QueueLine => ({ pos, text: say('ql.soon'), cancelled: false });

  if (task.status === 'blocked') {
    const depId = task.afterTaskId ?? '';
    const dep = ctx.tasks.find((x) => x.id === depId) ?? null;
    const next = afterDependency(dep);
    if (next === 'cancel') return { pos: null, text: say('ql.cancelled', { id: dep?.id ?? depId }), cancelled: true };
    if (next === 'start') return soon(null);
    if (dep && hasOpenPr(dep)) return { pos: null, text: say('ql.afterPr', { n: prNo(dep.prUrl) }), cancelled: false };
    return { pos: null, text: say('ql.afterTask', { id: depId }), cancelled: false };
  }

  if (waitsForSlot(task)) {
    // No place when the task is not among ctx.tasks: it is shown as held, never as a second "next".
    const pos = queuePlace(ctx.tasks, task.id)?.pos ?? null;
    if (canStart(ctx.tasks, task.workerId ?? task.id, ctx.maxWorkers)) return soon(pos);
    return { pos, text: pos === null || pos === 1 ? say('ql.next') : say('ql.place', { pos, ord: ordinal(pos) }), cancelled: false };
  }

  const ends = ctx.accounts.map((a) => (a.limitedUntil ? Date.parse(a.limitedUntil) : 0));
  if (!ends.length || ends.some((e) => !(e > now))) {
    return canStart(ctx.tasks, task.workerId ?? task.id, ctx.maxWorkers) ? soon(null) : { pos: null, text: say('ql.limitSlot'), cancelled: false };
  }
  const at = Math.min(...ends);
  return { pos: null, text: say('ql.limit', { account: ctx.accounts[ends.indexOf(at)].label, time: ctx.time(at) }), cancelled: false };
}
