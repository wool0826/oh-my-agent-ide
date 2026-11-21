import type { UsageWindow } from './types';

/**
 * A usage window whose reset time has passed no longer says anything: the real value is unknown and low.
 * Without this, an old high value would keep ranking the account last after its window reset.
 */
export function liveWindow(w: UsageWindow, now = Date.now()): UsageWindow {
  return w.resetsAt && Date.parse(w.resetsAt) <= now ? { utilization: null, resetsAt: null } : w;
}

/** What account routing needs to know about an account. */
export interface RoutableAccount {
  id: string;
  fiveHour: UsageWindow;
  sevenDay: UsageWindow;
  /** Set when a usage limit actually rejected the account: when that limit resets. */
  limitedUntil: string | null;
  lastAssignedAt: string | null;
}

/** The fuller of the live 5h and 7d windows, in percent (0 when unknown). */
export function usageScore(a: RoutableAccount, now = Date.now()) {
  return Math.max(liveWindow(a.fiveHour, now).utilization ?? 0, liveWindow(a.sevenDay, now).utilization ?? 0);
}

/** True while a usage limit has rejected the account and has not reset yet. High usage alone does not count. */
export function isExhausted(a: RoutableAccount, now = Date.now()) {
  return !!a.limitedUntil && Date.parse(a.limitedUntil) > now;
}

/**
 * The account for a new session: the lowest usage among accounts not exhausted, however high that usage is;
 * within 5 points, the one assigned longest ago. Null when every account (other than `exclude`) is exhausted.
 */
export function chooseAccount<T extends RoutableAccount>(list: readonly T[], now = Date.now(), exclude?: string | null): T | null {
  const pool = list.filter((a) => a.id !== exclude && !isExhausted(a, now));
  if (!pool.length) return null;
  return [...pool].sort((x, y) => {
    const d = usageScore(x, now) - usageScore(y, now);
    if (Math.abs(d) > 5) return d;
    return Date.parse(x.lastAssignedAt ?? '1970-01-01') - Date.parse(y.lastAssignedAt ?? '1970-01-01');
  })[0];
}

/** When every account is exhausted: the time (ms) the first one resets. Null when one is free now or there are none. */
export function nextFreeAt(list: readonly RoutableAccount[], now = Date.now()): number | null {
  if (!list.length || list.some((a) => !isExhausted(a, now))) return null;
  return Math.min(...list.map((a) => Date.parse(a.limitedUntil!)));
}

/**
 * When a limit rejection ends. The rejection's own reset time if it has one; otherwise the latest reset among
 * windows that are (nearly) full, since a full 7-day window outlasts the 5-hour one; otherwise 30 minutes.
 */
export function limitEnd(a: RoutableAccount, now = Date.now(), resetsAtMs?: number) {
  if (resetsAtMs && resetsAtMs > now) return resetsAtMs;
  const full = [a.fiveHour, a.sevenDay]
    .map((w) => liveWindow(w, now))
    .filter((w) => (w.utilization ?? 0) >= 95 && w.resetsAt)
    .map((w) => Date.parse(w.resetsAt!))
    .filter((ms) => ms > now);
  return full.length ? Math.max(...full) : now + 30 * 60_000;
}
