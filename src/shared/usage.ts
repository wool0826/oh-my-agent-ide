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

/** How often usage is read, in minutes; 0 = only by hand. Each round costs a request per token account. */
export const USAGE_INTERVALS = [5, 15, 30, 0] as const;
export const USAGE_INTERVAL_DEFAULT = 5;

export function clampUsageMins(v: unknown): number {
  const n = Number(v);
  return (USAGE_INTERVALS as readonly number[]).includes(n) ? n : USAGE_INTERVAL_DEFAULT;
}

/**
 * Which window holds a limited account: the one whose reset is the limit's end (within a minute), else a full one
 * (the week first, as it lasts longer). Null when neither says.
 */
export function limitWindow(a: { fiveHour: UsageWindow; sevenDay: UsageWindow; limitedUntil: string | null }): '5h' | '7d' | null {
  if (!a.limitedUntil) return null;
  const end = Date.parse(a.limitedUntil);
  const near = (w: UsageWindow) => !!w.resetsAt && Math.abs(Date.parse(w.resetsAt) - end) < 60_000;
  if (near(a.sevenDay)) return '7d';
  if (near(a.fiveHour)) return '5h';
  if ((a.sevenDay.utilization ?? 0) >= 100) return '7d';
  if ((a.fiveHour.utilization ?? 0) >= 100) return '5h';
  return null;
}

/**
 * An account whose usage is used up (a limit holds it, or a window is at 100%) and when it comes back: the limit's
 * end, else the latest reset among the full windows. Null when nothing is used up; `at` is null when no time is known.
 * A reset that has passed since the figures were read gives the usage back.
 */
export function usedUp(a: { limited: boolean; limitedUntil: string | null; fiveHour: UsageWindow; sevenDay: UsageWindow }, now = Date.now()): { at: string | null } | null {
  const past = (iso: string | null) => !!iso && Date.parse(iso) <= now;
  const full = [a.fiveHour, a.sevenDay].filter((w) => (w.utilization ?? 0) >= 100 && !past(w.resetsAt));
  const limited = a.limited && !past(a.limitedUntil);
  if (!limited && !full.length) return null;
  if (limited && a.limitedUntil) return { at: a.limitedUntil };
  const ends = full.map((w) => w.resetsAt).filter((r): r is string => !!r).sort((x, y) => Date.parse(x) - Date.parse(y));
  return { at: ends.at(-1) ?? null };
}

/** The app's rounds of reading usage. */
export interface UsageClock {
  /** When the last round ended. */
  checkedAt: string | null;
  /** When the next one starts; null when only by hand. */
  nextAt: string | null;
  running: boolean;
}

/** What an account needs for the popover's foot. */
export interface FootAccount {
  kind: 'token' | 'login';
  provider: Provider;
  lastError: string | null;
  usageUpdatedAt: string | null;
  usageBackoffUntil?: string | null;
}

export type UsageFoot =
  | { kind: 'running'; was: string | null }
  | { kind: 'paused'; until: string }
  | { kind: 'failed'; last: string | null }
  | { kind: 'ok'; at: string | null; next: string | null; failed: number; total: number }
  | { kind: 'sessions' };

/**
 * The popover's foot line: a round running; every account the rounds read paused by the server (429) or failed;
 * otherwise when it last ran, when it runs next and how many failed. Accounts that only their sessions report
 * (this PC's Claude login) are not read by a round.
 */
export function usageFoot(clock: UsageClock, list: readonly FootAccount[], now = Date.now()): UsageFoot {
  const read = list.filter((a) => a.kind === 'token' || a.provider === 'chatgpt');
  if (!read.length) return { kind: 'sessions' };
  if (clock.running) return { kind: 'running', was: clock.checkedAt };
  const pausedUntil = (a: FootAccount) => (a.usageBackoffUntil && Date.parse(a.usageBackoffUntil) > now ? a.usageBackoffUntil : null);
  if (read.every((a) => pausedUntil(a))) {
    return { kind: 'paused', until: new Date(Math.min(...read.map((a) => Date.parse(pausedUntil(a)!)))).toISOString() };
  }
  const failed = read.filter((a) => a.lastError).length;
  if (failed === read.length) {
    const times = read.map((a) => a.usageUpdatedAt).filter((x): x is string => !!x).sort();
    return { kind: 'failed', last: times.length ? times[times.length - 1] : null };
  }
  return { kind: 'ok', at: clock.checkedAt, next: clock.nextAt, failed, total: read.length };
}
