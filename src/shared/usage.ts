import type { UsageWindow } from './types';

/**
 * A usage window whose reset time has passed no longer says anything: the real value is unknown and low.
 * Without this, an account recorded above the limit threshold stays "limited" forever when nothing refreshes it
 * (login accounts only learn usage from running sessions, and no session starts while every account looks limited).
 */
export function liveWindow(w: UsageWindow, now = Date.now()): UsageWindow {
  return w.resetsAt && Date.parse(w.resetsAt) <= now ? { utilization: null, resetsAt: null } : w;
}
