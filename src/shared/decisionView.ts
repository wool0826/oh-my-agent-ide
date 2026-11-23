import { ALLOW, ALLOW_TASK, DENY } from './types';
import type { Decision, Task } from './types';

/**
 * How a decision card reads and answers to the keyboard: its kind, how long it has waited, the slot its Worker
 * keeps meanwhile, and the keys of the selected card. Pure, so the renderer and the tests share it.
 */

export type DecisionKind = 'command' | 'permission' | 'question' | 'plan';

/** A command asks to run a shell line (its code starts with "$ "); any other permission is about files or a tool. */
export function decisionKind(d: Pick<Decision, 'source' | 'code'>): DecisionKind {
  if (d.source === 'plan') return 'plan';
  if (d.source === 'permission') return String(d.code ?? '').startsWith('$ ') ? 'command' : 'permission';
  return 'question';
}

export type SlotClock = { state: 'holding'; left: number; frac: number } | { state: 'released' } | null;

/**
 * The slot a waiting Worker keeps while the user decides (see waitStep in slots.ts): the time left of `minutes`,
 * or released once it has given the slot back. None when the task does not wait or the slot is kept for good (0).
 */
export function slotClock(t: Pick<Task, 'status' | 'waitingSince' | 'slotReleased'> | null | undefined, now: number, minutes: number): SlotClock {
  if (!t || t.status !== 'waiting') return null;
  if (t.slotReleased) return { state: 'released' };
  if (!t.waitingSince || minutes <= 0) return null;
  const total = minutes * 60_000;
  const left = Math.max(0, total - (now - Date.parse(t.waitingSince)));
  return { state: 'holding', left, frac: left / total };
}

/** Late, so its age reads orange: a quarter or less of the slot is left, the slot is gone, or with no clock 10 minutes have passed. */
export function decisionLate(createdAt: string, clock: SlotClock, now: number): boolean {
  if (clock?.state === 'released') return true;
  if (clock?.state === 'holding') return clock.frac <= 0.25;
  return now - Date.parse(createdAt) >= 10 * 60_000;
}

/** Whole minutes since `at`, never below 0. */
export function ageMinutes(at: string, now: number): number {
  return Math.max(0, Math.floor((now - Date.parse(at)) / 60_000));
}

/** What a key does on the selected card. */
export type CardKey = { act: 'enter' | 'deny' | 'task' | 'next' | 'prev' } | { act: 'pick'; n: number };

/**
 * Reads a key press for the selected card. By the physical key (e.code), so a Korean or other input method gives the
 * same result; nothing while text is being composed or with a modifier held.
 */
export function cardKey(e: { code: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean; isComposing?: boolean; keyCode?: number }): CardKey | null {
  if (e.isComposing || e.keyCode === 229 || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return null;
  switch (e.code) {
    case 'Enter': case 'NumpadEnter': return { act: 'enter' };
    case 'KeyD': return { act: 'deny' };
    case 'KeyT': return { act: 'task' };
    case 'ArrowDown': return { act: 'next' };
    case 'ArrowUp': return { act: 'prev' };
  }
  const m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
  return m ? { act: 'pick', n: Number(m[1]) } : null;
}

/** The answer a key gives on this decision, or null when the key means nothing on it. */
export function keyAnswer(d: Pick<Decision, 'source' | 'options'>, k: CardKey): string | null {
  if (d.source === 'plan') return k.act === 'enter' ? ALLOW : null;
  if (d.source === 'permission') {
    if (k.act === 'enter') return ALLOW;
    if (k.act === 'deny') return DENY;
    if (k.act === 'task') return d.options.some((o) => o.label === ALLOW_TASK) ? ALLOW_TASK : null;
    return null;
  }
  if (k.act === 'pick') return d.options[k.n - 1]?.label ?? null;
  return null;
}

/** The key hint each answer of the card shows: answer value to key label ('↵', 'D', 'T', '1'…'9'). */
export function decisionKeys(d: Pick<Decision, 'source' | 'options'>): Map<string, string> {
  const out = new Map<string, string>();
  if (d.source === 'plan') out.set(ALLOW, '↵');
  else if (d.source === 'permission') {
    out.set(ALLOW, '↵');
    out.set(DENY, 'D');
    if (d.options.some((o) => o.label === ALLOW_TASK)) out.set(ALLOW_TASK, 'T');
  } else d.options.slice(0, 9).forEach((o, i) => { if (!out.has(o.label)) out.set(o.label, String(i + 1)); });
  return out;
}

/** The card `step` places from `cur` (stopping at the ends); the first card when `cur` is gone. */
export function nextCard(ids: string[], cur: string | null, step: number): string | null {
  if (!ids.length) return null;
  const at = cur ? ids.indexOf(cur) : -1;
  if (at < 0) return ids[0];
  return ids[Math.min(ids.length - 1, Math.max(0, at + step))];
}

/** The card to select: the one kept if it still waits, else the one after the answered one (or before it at the end). */
export function keepCard(ids: string[], cur: string | null, before: string[]): string | null {
  if (cur && ids.includes(cur)) return cur;
  if (!ids.length) return null;
  const was = cur ? before.indexOf(cur) : -1;
  if (was < 0) return ids[0];
  // The first card after the gone one that still waits.
  for (const id of before.slice(was + 1)) if (ids.includes(id)) return id;
  return ids[ids.length - 1];
}
