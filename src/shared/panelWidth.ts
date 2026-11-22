// How wide the left sidebar and the right sidebar are: the width the user dragged to, kept within limits,
// and fitted to the window so the main area between them stays usable.

export type Panel = 'side' | 'ins';

export interface PanelLimits { def: number; min: number; max: number }

/** Defaults match --sidebar-w and --inspector-w in tokens.css. */
export const PANELS: Record<Panel, PanelLimits> = {
  side: { def: 272, min: 200, max: 480 },
  // Below 320 the right sidebar's Inbox, Memos and Automations tabs wrap to two lines.
  ins: { def: 344, min: 320, max: 640 },
};

/** The main area never gets narrower than this while a panel can still give way. */
export const MAIN_MIN = 420;
/** The collapsed left sidebar (--rail-w in styles.css). */
export const RAIL_W = 60;
/** One arrow key press; with Shift, four. */
export const KEY_STEP = 16;

export interface Widths { side: number; ins: number }
export interface Layout { winW: number; sideMin: boolean; insMin: boolean }

const within = (p: Panel, w: number) => Math.round(Math.min(PANELS[p].max, Math.max(PANELS[p].min, w)));

/** A stored width, or the default when there is none or it is not a number. */
export function parseWidth(p: Panel, raw: string | null | undefined): number {
  const n = raw == null || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) ? within(p, n) : PANELS[p].def;
}

/**
 * The widths shown: each kept within its limits, then narrowed (the right one first, never below its minimum)
 * while the main area would be narrower than MAIN_MIN. A collapsed panel keeps its width for when it opens again.
 */
export function fitWidths(w: Widths, l: Layout): Widths {
  let side = within('side', w.side);
  let ins = within('ins', w.ins);
  let over = (l.sideMin ? RAIL_W : side) + (l.insMin ? 0 : ins) + MAIN_MIN - l.winW;
  if (over > 0 && !l.insMin) { const cut = Math.min(over, ins - PANELS.ins.min); ins -= cut; over -= cut; }
  if (over > 0 && !l.sideMin) side -= Math.min(over, side - PANELS.side.min);
  return { side, ins };
}

/** The widest panel `p` may be now: its maximum, or what leaves MAIN_MIN beside the other panel as shown. */
export function maxWidth(p: Panel, w: Widths, l: Layout): number {
  const shown = fitWidths(w, l);
  const other = p === 'side' ? (l.insMin ? 0 : shown.ins) : (l.sideMin ? RAIL_W : shown.side);
  return Math.max(PANELS[p].min, Math.min(PANELS[p].max, l.winW - other - MAIN_MIN));
}

/** The width a drag or a key asks for, kept between the minimum and maxWidth. */
export function clampWidth(p: Panel, want: number, w: Widths, l: Layout): number {
  return Math.round(Math.min(maxWidth(p, w, l), Math.max(PANELS[p].min, want)));
}

/**
 * The width a key on panel `p`'s handle asks for, or null for other keys. The arrows move the handle:
 * Right widens the left sidebar and narrows the right one. Home and End go to the minimum and the maximum.
 */
export function keyWidth(p: Panel, key: string, shift: boolean, now: number, w: Widths, l: Layout): number | null {
  const step = KEY_STEP * (shift ? 4 : 1);
  const dir = key === 'ArrowRight' ? 1 : key === 'ArrowLeft' ? -1 : 0;
  if (dir) return clampWidth(p, now + (p === 'side' ? dir : -dir) * step, w, l);
  if (key === 'Home') return PANELS[p].min;
  if (key === 'End') return maxWidth(p, w, l);
  return null;
}
