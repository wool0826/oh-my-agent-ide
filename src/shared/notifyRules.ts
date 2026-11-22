// When the app stays quiet: do-not-disturb hours, and notifications that come in a burst (decision 136).

import { parseTime } from './automations';

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
