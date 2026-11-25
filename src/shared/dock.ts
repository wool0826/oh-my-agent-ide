// The dock under the chat (T-0081, G1 of the T-0079 audit): the side terminal and the side question as two tabs of
// one panel between the chat and its composer, so the chat gets shorter instead of being covered. Only its height
// changes: it spans the chat's width.

export type DockTab = 'tm' | 'sq';

export const DOCK_MIN = 160;
export const DOCK_DEF = 300;
/** One arrow key press on the handle; with Shift, four. */
export const DOCK_STEP = 16;

/** Within its limits and the room it has (the chat's height less what the chat keeps); the least size wins a small window. */
export function clampDockH(h: number, room: number): number {
  const v = Number.isFinite(h) ? h : DOCK_DEF;
  return Math.round(Math.max(DOCK_MIN, Math.min(v, Math.max(DOCK_MIN, room))));
}

/** A stored height, or the first one. */
export function parseDockH(raw: string | null | undefined): number {
  const n = Number(raw);
  return raw && Number.isFinite(n) && n > 0 ? n : DOCK_DEF;
}

/** ↑ makes it taller and ↓ shorter (its handle is on its top edge); Shift by four steps. Null for any other key. */
export function keyDockH(key: string, shift: boolean, now: number, room: number): number | null {
  const d = { ArrowUp: 1, ArrowDown: -1 }[key];
  if (!d) return null;
  return clampDockH(clampDockH(now, room) + d * DOCK_STEP * (shift ? 4 : 1), room);
}
