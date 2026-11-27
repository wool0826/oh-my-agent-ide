// An account the user switched off in Settings: no new task, Worker or Dispatcher session starts on it, while the
// sessions already on it run to the end. Off until switched on again, or off for an hour. The usage of an account
// that is off is still read, so its numbers are current when it comes back.

/** On; off for an hour, then on again by itself; off until switched on. */
export type AssignMode = 'on' | 'hour' | 'off';

export const ASSIGN_MODES: readonly AssignMode[] = ['on', 'hour', 'off'];
export const PAUSE_HOUR_MS = 60 * 60_000;

/** What an account keeps of the switch (settings.json). Accounts saved before it existed have neither field: on. */
export interface Pausable {
  paused?: boolean;
  /** Set for a pause of an hour: when it ends. Null while it is off until switched on. */
  pausedUntil?: string | null;
}

/** Off now: switched off, or an hour's pause that has not ended. */
export function isPaused(a: Pausable, now = Date.now()): boolean {
  if (a.paused !== true) return false;
  if (!a.pausedUntil) return true;
  const end = Date.parse(a.pausedUntil);
  // An end that can't be read keeps the account off: the user did switch it off.
  return !Number.isFinite(end) || end > now;
}

/** When an hour's pause ends (ms); null for an account that is on or off until switched on. */
export function pauseEnd(a: Pausable, now = Date.now()): number | null {
  if (!isPaused(a, now) || !a.pausedUntil) return null;
  const end = Date.parse(a.pausedUntil);
  return Number.isFinite(end) ? end : null;
}

export function assignMode(a: Pausable, now = Date.now()): AssignMode {
  if (!isPaused(a, now)) return 'on';
  return pauseEnd(a, now) !== null ? 'hour' : 'off';
}

/** The fields an account gets for a choice of the switch. */
export function pauseFields(mode: AssignMode, now = Date.now()): Required<Pausable> {
  if (mode === 'hour') return { paused: true, pausedUntil: new Date(now + PAUSE_HOUR_MS).toISOString() };
  return { paused: mode === 'off', pausedUntil: null };
}

/**
 * The switch as loaded from settings.json: missing fields (an account saved before the switch) and an hour that has
 * passed read as on; anything but `true` is not off.
 */
export function cleanPause(a: Pausable, now = Date.now()): Required<Pausable> {
  if (!isPaused(a, now)) return { paused: false, pausedUntil: null };
  return { paused: true, pausedUntil: typeof a.pausedUntil === 'string' ? a.pausedUntil : null };
}

/** Accounts that are on. */
export function activeOf<T extends Pausable>(list: readonly T[], now = Date.now()): T[] {
  return list.filter((a) => !isPaused(a, now));
}

/** Every registered account is off: nothing can start, and Settings and the chat say so. False with no accounts. */
export function allPaused(list: readonly Pausable[], now = Date.now()): boolean {
  return list.length > 0 && list.every((a) => isPaused(a, now));
}

/** The first hour's pause to end (ms), for a timer that turns the account back on; null when none is timed. */
export function nextPauseEnd(list: readonly Pausable[], now = Date.now()): number | null {
  const ends = list.map((a) => pauseEnd(a, now)).filter((e): e is number => e !== null);
  return ends.length ? Math.min(...ends) : null;
}

/**
 * What a session does with its account before it takes work: keep it, move to another (it resumes there), or wait
 * (nothing can carry it now). A turn in progress keeps its account: switching an account off stops nothing. A live
 * session between turns on an account switched off moves when another is free; with none left, only work already
 * begun goes on there, and a new task waits. A live session on a limited account keeps it: the limit moves it.
 */
export function sessionAccountStep(s: { free: boolean; live: boolean; busy: boolean; paused: boolean; otherFree: boolean; begun: boolean }): 'keep' | 'move' | 'wait' {
  if (s.free || s.busy || (s.live && !s.paused)) return 'keep';
  if (s.otherFree) return 'move';
  return s.live && s.begun ? 'keep' : 'wait';
}

/** Workers at work on an account: what still runs there after it is switched off ("Off · 2 running"). */
export function runningOn(workers: readonly { accountId: string | null; status: string }[], id: string): number {
  return workers.filter((w) => w.accountId === id && (w.status === 'running' || w.status === 'waiting' || w.status === 'starting')).length;
}
