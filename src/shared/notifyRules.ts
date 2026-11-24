// When the app stays quiet: do-not-disturb hours, and notifications that come in a burst (decision 136).

import { parseTime } from './automations';
import type { Say } from './askWhy';

/** A "HH:MM" as minutes of the day, or null. */
function minutes(v: string): number | null {
  const t = parseTime(v);
  return t ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3)) : null;
}

/**
 * Is `now` inside the quiet hours? The end is not included, and hours that pass midnight (22:00 to 07:00) work.
 * Off when either time is missing or unreadable, or when both are the same.
 */
export function inQuietHours(from: string, to: string, now: Date): boolean {
  const a = minutes(from), b = minutes(to);
  if (a === null || b === null || a === b) return false;
  const n = now.getHours() * 60 + now.getMinutes();
  return a < b ? n >= a && n < b : n >= a || n < b;
}

/** A stored time as "HH:MM", or '' when it is not one. */
export function cleanTime(v: unknown): string {
  return typeof v === 'string' ? parseTime(v) ?? '' : '';
}

/**
 * What a typed time is saved as: the time when it reads as one, '' when the field was emptied, and the time in use
 * when the text is not a time, so a slip of the hand does not switch the hours off.
 */
export function typedTime(v: string, inUse: string): string {
  return v.trim() ? parseTime(v) ?? inUse : '';
}

/** Notifications of one source closer together than this are one burst: the first is shown, the rest are not. */
export const BURST_MS = 20_000;

/**
 * Keeps the time of the last notification per source. `allow` says whether one may be shown now and, when it
 * may, records it. A source that keeps notifying inside the window stays quiet until it has paused for the window.
 */
export class Burst {
  private last = new Map<string, number>();
  constructor(private windowMs = BURST_MS) {}
  allow(source: string, now: number): boolean {
    const prev = this.last.get(source);
    this.last.set(source, now);
    return prev === undefined || now - prev >= this.windowMs;
  }
}

/**
 * Whether task-end notifications are on. Settings saved before they had a switch of their own let them through only
 * when both old switches did ("OS notifications", which now means decisions only, and "Notify when a task ends").
 */
export function notifyDoneFrom(raw: { notifyDone?: unknown; notifications?: unknown; notifyResults?: unknown }): boolean {
  if (typeof raw.notifyDone === 'boolean') return raw.notifyDone;
  return raw.notifications !== false && raw.notifyResults !== false;
}

/**
 * A task-end notification: who ended it and how (done, or failed), with its PR or "no PR" for code, then the task's
 * title over one short line of its result.
 */
export function doneNotice(say: Say, a: { who: string; title: string; summary: string; ok: boolean; label?: string; code?: boolean; prUrl?: string | null }) {
  const num = a.prUrl?.match(/\/pull\/(\d+)/)?.[1];
  const pr = num ? say('noti.pr', { n: num }) : a.ok && a.code ? say('noti.noPr') : '';
  const line = a.summary.replace(/\s+/g, ' ').trim();
  return {
    title: [`${a.who} ${a.ok ? a.label ?? say('res.doneLabel') : say('noti.failed')}`, pr].filter(Boolean).join(' · '),
    body: [a.title, line.length > 120 ? `${line.slice(0, 119)}…` : line].filter(Boolean).join('\n'),
  };
}
