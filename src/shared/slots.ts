// How many Workers may run at once, and which waiting task gets a slot next.
// Shared by the main process (which starts tasks) and the renderer (which shows "3/3").

import type { Task } from './types';

export const MAX_WORKERS_DEFAULT = 3;
export const MAX_WORKERS_MIN = 1;
export const MAX_WORKERS_MAX = 8;

/** A whole number in range; anything unreadable is the default. */
export function clampMaxWorkers(v: unknown): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return MAX_WORKERS_DEFAULT;
  return Math.min(MAX_WORKERS_MAX, Math.max(MAX_WORKERS_MIN, n));
}

/**
 * A task running, or waiting for an answer, holds its Worker's slot: it runs again as soon as the answer comes.
 * A task that has waited longer than the setting allows gave its slot back (slotReleased), so the queue moves
 * while the user is away. It still runs at once when answered, which can put one more Worker at work than the limit.
 */
export function holdsSlot(t: Pick<Task, 'status' | 'slotReleased'>): boolean {
  return t.status === 'running' || (t.status === 'waiting' && !t.slotReleased);
}

export const WAIT_SLOT_DEFAULT = 10;
export const WAIT_SLOT_MAX = 240;

/** Minutes a waiting Worker keeps its slot; 0 keeps it for as long as it waits. */
export function clampWaitSlot(v: unknown): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return WAIT_SLOT_DEFAULT;
  return Math.min(WAIT_SLOT_MAX, Math.max(0, n));
}

/**
 * What the periodic check does with a task: start timing a wait (mark), give the slot back once it has waited
 * `minutes` (release), or forget both once it no longer waits (clear).
 */
export function waitStep(t: Pick<Task, 'status' | 'waitingSince' | 'slotReleased'>, now: number, minutes: number): 'mark' | 'release' | 'clear' | null {
  if (t.status !== 'waiting') return t.waitingSince || t.slotReleased ? 'clear' : null;
  if (!t.waitingSince) return 'mark';
  if (t.slotReleased || minutes <= 0) return null;
  return now - Date.parse(t.waitingSince) >= minutes * 60_000 ? 'release' : null;
}

/** Workers holding a slot. A Worker counts once, however many of its tasks are open. */
export function slotHolders(tasks: Pick<Task, 'status' | 'workerId' | 'id' | 'slotReleased'>[]): Set<string> {
  return new Set(tasks.filter(holdsSlot).map((t) => t.workerId ?? t.id));
}

export function slotsUsed(tasks: Pick<Task, 'status' | 'workerId' | 'id' | 'slotReleased'>[]): number {
  return slotHolders(tasks).size;
}

/** A Worker that already holds a slot may start more work; any other needs a free one. */
export function canStart(tasks: Pick<Task, 'status' | 'workerId' | 'id' | 'slotReleased'>[], workerId: string, max: number): boolean {
  const held = slotHolders(tasks);
  return held.has(workerId) || held.size < max;
}

/** Queued because every slot was taken, not because of a usage limit. */
export function waitsForSlot(t: Pick<Task, 'status' | 'queueReason'>): boolean {
  return t.status === 'queued' && t.queueReason === 'slot';
}

/** Queued until a usage limit resets. Tasks queued before slots existed have no reason and waited for a limit. */
export function waitsForLimit(t: Pick<Task, 'status' | 'queueReason'>): boolean {
  return t.status === 'queued' && t.queueReason !== 'slot';
}

/**
 * Queued tasks of one kind, the longest waiting first.
 * A queued task's updatedAt is when it joined the queue: nothing else changes a task while it waits.
 */
export function queueOrder<T extends Pick<Task, 'status' | 'queueReason' | 'updatedAt'>>(tasks: T[], reason: 'slot' | 'limit'): T[] {
  const pick = reason === 'slot' ? waitsForSlot : waitsForLimit;
  return tasks.filter(pick).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
}
