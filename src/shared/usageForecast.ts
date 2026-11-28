// The usage warning (T-0180, spec 8B): past a threshold, a chip on the strip says which window and when it runs out
// at the pace so far; at a limit, when it comes back. Settings > Accounts sets the threshold.
import type { UsageWindow } from './types';
import { isPaused, type Pausable } from './accountPause';
import { isExhausted, usedUp } from './usage';

/** The thresholds Settings offers, in percent. */
export const WARN_LEVELS = [80, 90, 95] as const;
export const WARN_DEFAULT = 90;

/** A threshold from settings.json: one of WARN_LEVELS, else the default. */
export function clampWarnAt(v: unknown): number {
  return (WARN_LEVELS as readonly number[]).includes(Number(v)) ? Number(v) : WARN_DEFAULT;
}

/** A Claude account's windows in minutes; a ChatGPT one says its own (`windowMins`). */
const SPANS = [300, 7 * 24 * 60] as const;

/**
 * When `w` runs out at its pace since the window began (ms): the share used so far over the time gone. Null when that
 * is unknown or comes after the reset; `now` when it is already full.
 */
export function exhaustAt(w: UsageWindow, spanMins: number, now = Date.now()): number | null {
  const u = w.utilization;
  if (u === null || u <= 0 || !w.resetsAt) return null;
  const reset = Date.parse(w.resetsAt);
  if (!Number.isFinite(reset) || reset <= now) return null;
  if (u >= 100) return now;
  const gone = now - (reset - spanMins * 60_000);
  if (gone <= 0) return null;
  const at = now + ((100 - u) * gone) / u;
  return at < reset ? at : null;
}

export interface WarnAccount extends Pausable {
  id: string;
  limited: boolean;
  limitedUntil: string | null;
  fiveHour: UsageWindow;
  sevenDay: UsageWindow;
  windowMins?: [number | null, number | null] | null;
}

export type UsageWarning =
  /** Used up: back at `at` (null when unknown). */
  | { kind: 'limit'; id: string; at: string | null }
  /** Past the threshold: the fuller window, its use, its reset and when it runs out (null: not before the reset). */
  | { kind: 'warn'; id: string; win: 0 | 1; pct: number; reset: string | null; exhaust: number | null };

/** One account's warning, or null when it is under the threshold or switched off. Win 0 is the 5h window, 1 the 7d. */
export function accountWarning(a: WarnAccount, warnAt: number, now = Date.now()): UsageWarning | null {
  if (isPaused(a, now)) return null;
  const out = usedUp(a, now);
  if (out) return { kind: 'limit', id: a.id, at: out.at };
  let best: Extract<UsageWarning, { kind: 'warn' }> | null = null;
  for (const i of [0, 1] as const) {
    const w = i ? a.sevenDay : a.fiveHour;
    const pct = w.utilization;
    if (pct === null || pct < warnAt || (w.resetsAt && Date.parse(w.resetsAt) <= now)) continue;
    if (best && best.pct >= pct) continue;
    const span = a.windowMins?.[i] ?? SPANS[i];
    best = { kind: 'warn', id: a.id, win: i, pct, reset: w.resetsAt, exhaust: exhaustAt(w, span, now) };
  }
  return best;
}

/**
 * The strip's one chip for every account: an account at its limit first (the one back soonest), else the fullest
 * past the threshold. Null when none is.
 */
export function stripWarning(list: readonly WarnAccount[], warnAt: number, now = Date.now()): UsageWarning | null {
  const all = list.map((a) => accountWarning(a, warnAt, now)).filter((w): w is UsageWarning => !!w);
  const limits = all.filter((w) => w.kind === 'limit');
  if (limits.length) {
    const t = (w: UsageWarning) => (w.kind === 'limit' && w.at ? Date.parse(w.at) : Infinity);
    return [...limits].sort((x, y) => t(x) - t(y))[0];
  }
  return [...all].sort((x, y) => (y.kind === 'warn' ? y.pct : 0) - (x.kind === 'warn' ? x.pct : 0))[0] ?? null;
}

/**
 * The warnings to notify now: each account's window that crossed the threshold since the last look, once per window
 * period. `seen` holds the keys already told and is updated in place.
 */
export function newWarnings(list: readonly WarnAccount[], warnAt: number, seen: Set<string>, now = Date.now()): Extract<UsageWarning, { kind: 'warn' }>[] {
  const out: Extract<UsageWarning, { kind: 'warn' }>[] = [];
  for (const a of list) {
    const w = accountWarning(a, warnAt, now);
    if (w?.kind !== 'warn') continue;
    // The reset comes as ISO text from the usage API and as epoch seconds from a session: the same period, rounded.
    const reset = w.reset ? Math.round(Date.parse(w.reset) / 600_000) : '';
    const key = `${a.id}|${w.win}|${reset}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  return out;
}

/** The account is past the threshold in a window: with "Switch accounts before the limit", it takes nothing new. */
export function nearLimit(a: Pick<WarnAccount, 'fiveHour' | 'sevenDay'>, warnAt: number, now = Date.now()): boolean {
  return [a.fiveHour, a.sevenDay].some((w) => (w.utilization ?? 0) >= warnAt && !(w.resetsAt && Date.parse(w.resetsAt) <= now));
}

/** A window's short name: 5h and 7d for Claude; a ChatGPT plan's own length (`windowMins`), in hours or days. */
export function winName(win: 0 | 1, windowMins?: [number | null, number | null] | null): string {
  const mins = windowMins?.[win];
  if (!mins) return win ? '7d' : '5h';
  return mins < 1440 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`;
}

/**
 * "Switch accounts before the limit": the session on account `id` moves between turns when that account is past the
 * threshold and another account of the provider is under it, free and switched on. Picking then takes the lowest.
 */
export function leaveEarly(list: readonly (Pick<WarnAccount, 'id' | 'fiveHour' | 'sevenDay' | 'limitedUntil'> & Pausable & { provider?: string })[], id: string | null, warnAt: number, provider = 'claude', now = Date.now()): boolean {
  const a = list.find((x) => x.id === id);
  if (!a || !nearLimit(a, warnAt, now)) return false;
  return list.some((o) => o.id !== id && (o.provider ?? 'claude') === provider && !isExhausted(o, now) && !isPaused(o, now) && !nearLimit(o, warnAt, now));
}
