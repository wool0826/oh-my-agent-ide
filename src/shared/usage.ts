import type { Provider, UsageWindow } from './types';

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
  /** Unset on accounts saved before ChatGPT accounts existed: Claude. */
  provider?: Provider;
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
export function chooseAccount<T extends RoutableAccount>(list: readonly T[], now = Date.now(), exclude?: string | null, provider?: Provider): T | null {
  // A session runs on one provider's agent, so only that provider's accounts can carry it.
  const pool = list.filter((a) => a.id !== exclude && !isExhausted(a, now) && (!provider || (a.provider ?? 'claude') === provider));
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

const PROVIDERS: Provider[] = ['claude', 'chatgpt'];
const ofProvider = (list: readonly RoutableAccount[], p: Provider) => list.filter((a) => (a.provider ?? 'claude') === p);

/**
 * The same per provider: a session can only run on its own provider's accounts, so a free Claude account does
 * not help one that waits for the ChatGPT account. Without `provider`: the first time any provider that is
 * fully held gets an account back (when work that waits should be tried again).
 */
export function nextFreeAtFor(list: readonly RoutableAccount[], provider?: Provider, now = Date.now()): number | null {
  if (provider) return nextFreeAt(ofProvider(list, provider), now);
  const times = PROVIDERS.map((p) => nextFreeAt(ofProvider(list, p), now)).filter((t): t is number => t !== null);
  return times.length ? Math.min(...times) : null;
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
