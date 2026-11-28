// Swiping a row of the right sidebar's list sideways: when a press becomes a sideways drag, how far a row that cannot
// be cleared gives, and whether letting go clears the row. The DOM part is in src/renderer/ui/swipe.ts.

/** How far the pointer moves before the drag counts as sideways or as a scroll. */
export const SWIPE_SLOP = 8;
/** Share of the row's width past which letting go clears it, kept between these distances (px) (T-0168). */
export const SWIPE_SHARE = 0.35;
export const SWIPE_CLEAR_MIN = 80;
export const SWIPE_CLEAR_MAX = 120;
/** A flick: this fast (px/ms) and this far (px) toward one side clears it too. */
export const SWIPE_FLICK_SPEED = 0.6;
export const SWIPE_FLICK_MIN = 32;
/** The most a row that cannot be cleared gives (px). */
export const SWIPE_RESIST_MAX = 14;

/** What a press has become: not yet known, a sideways drag, or a scroll (the swipe never starts then). */
export function swipeIntent(dx: number, dy: number, slop = SWIPE_SLOP): 'wait' | 'swipe' | 'scroll' {
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (ax < slop && ay < slop) return 'wait';
  return ax > ay * 1.2 ? 'swipe' : 'scroll';
}

/** Where a row that cannot be cleared is drawn: it follows a little, then stops, as if held. */
export function swipeResist(dx: number): number {
  return Math.sign(dx) * SWIPE_RESIST_MAX * (1 - Math.exp(-Math.abs(dx) / 60));
}

/** How far (px) a row `width` wide is moved before letting go clears it. */
export const swipeClearAt = (width: number) => Math.min(width, Math.max(SWIPE_CLEAR_MIN, Math.min(SWIPE_CLEAR_MAX, width * SWIPE_SHARE)));

/** Whether letting go at `dx`, moving at `v` px/ms, clears a row `width` wide. */
export function swipeClears(dx: number, v: number, width: number): boolean {
  if (!width || !dx) return false;
  if (Math.abs(dx) >= swipeClearAt(width)) return true;
  return Math.abs(dx) >= SWIPE_FLICK_MIN && Math.abs(v) >= SWIPE_FLICK_SPEED && Math.sign(v) === Math.sign(dx);
}

/**
 * A two-finger swipe on a touchpad ends when no wheel event (its own or its momentum) has come for this long (ms): a
 * short rest of the fingers does not end it.
 */
export const WHEEL_IDLE = 200;
/** How far (px) the wheel events of a gesture add up before it counts as sideways or as a scroll. */
export const WHEEL_SLOP = 12;
/** After a row is swiped away, wheel events start nothing for this long (ms): the row below has moved under the pointer. */
export const WHEEL_SETTLE = 350;
/**
 * Momentum (the wheel events a touchpad keeps sending once the fingers have left, on macOS and on Windows precision
 * touchpads): this many sideways steps in a row, each no bigger than the one before, down to this share of the last
 * step before them. The fingers left at that step: the row is let go there and the momentum moves nothing.
 */
export const COAST_RUN = 4;
export const COAST_DROP = 0.85;
/** From this many fading steps on, the row is drawn where the fingers left it: a fading step may be momentum. */
const COAST_HOLD = 2;
/** The steps of the last this many ms (before the fingers left) give the speed at letting go. */
const FLICK_WINDOW = 100;

/** Where a swipe is let go and how fast it was moving (px/ms), for swipeClears. */
export interface WheelRelease { dx: number; v: number }

/**
 * A touchpad swipe told by its wheel events: the row follows the fingers (`dx`, against the content's scroll, so it
 * goes the way the fingers go with natural scrolling and the way the drag goes), or it is a scroll and left alone.
 * Once the fingers have left (`done`), the rest of the gesture moves nothing.
 */
export interface WheelSwipe {
  mode: 'wait' | 'swipe' | 'scroll';
  dx: number;
  dy: number;
  /** Time of the last event that moved something. */
  t: number;
  /** Sideways steps in a row that faded, the size of the last step, and of the step before the fading ones. */
  run: number;
  prev: number;
  peak: number;
  /** Where the row was and when, before the fading steps: where the fingers left, if they are momentum. */
  base: number;
  baseT: number;
  /** Recent positions, for the speed at letting go. */
  trail: { x: number; t: number }[];
  done: WheelRelease | null;
}

export const wheelStart = (): WheelSwipe => ({ mode: 'wait', dx: 0, dy: 0, t: 0, run: 0, prev: 0, peak: 0, base: 0, baseT: 0, trail: [], done: null });

/** One wheel event: its deltas, their unit (`deltaMode` 1 is lines, 2 pages) and its time (ms). */
export interface WheelInput { deltaX: number; deltaY: number; deltaMode?: number; t: number }

/** Where the row is drawn: where the fingers left it while the steps fade. */
export const wheelShown = (s: WheelSwipe) => (s.run >= COAST_HOLD ? s.base : s.dx);

function speed(trail: WheelSwipe['trail'], at: number) {
  const pts = trail.filter((p) => p.t <= at && at - p.t <= FLICK_WINDOW);
  const a = pts[0], b = pts[pts.length - 1];
  return a && b && b.t > a.t ? (b.x - a.x) / (b.t - a.t) : 0;
}

/**
 * Lets the swipe go at `now`: where it is drawn, at the speed the fingers had when they left. Fingers that rested
 * before leaving (no event for a while, no momentum after) did not flick it.
 */
export function wheelRelease(s: WheelSwipe, now: number): WheelRelease {
  const coast = s.run >= COAST_HOLD;
  const left = coast ? s.baseT : s.t;
  return { dx: wheelShown(s), v: coast || now - left <= FLICK_WINDOW ? speed(s.trail, left) : 0 };
}

/** Adds one wheel event to the gesture; once a scroll, it stays one, and once let go it takes nothing more. */
export function wheelStep(s: WheelSwipe, e: WheelInput, width = 0): WheelSwipe {
  if (s.done || s.mode === 'scroll') return s;
  const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? (width || 400) : 1;
  const sx = -e.deltaX * k, sy = -e.deltaY * k;
  // An event that moves nothing: macOS sends one as the fingers leave.
  if (!sx && !sy) return s.mode === 'swipe' ? { ...s, done: wheelRelease(s, e.t) } : s;
  let dx = s.dx + sx;
  if (width) dx = Math.max(-width, Math.min(width, dx));
  const dy = s.dy + sy;
  const mode = s.mode === 'wait' ? swipeIntent(dx, dy, WHEEL_SLOP) : s.mode;
  if (mode !== 'swipe' || s.mode !== 'swipe' || !sx) return { ...s, mode, dx, dy, t: e.t, prev: Math.abs(sx) || s.prev, trail: [...s.trail, { x: dx, t: e.t }] };
  const m = Math.abs(sx);
  // A step smaller than the last fades; an equal one only keeps a fade going (a held tilt wheel sends equal steps).
  const fades = m < s.prev || (m === s.prev && s.run > 0);
  const n: WheelSwipe = { ...s, dx, dy, t: e.t, prev: m, run: fades ? s.run + 1 : 0, trail: [...s.trail.filter((p) => e.t - p.t <= 300), { x: dx, t: e.t }] };
  if (fades && !s.run) { n.base = s.dx; n.baseT = s.t; n.peak = s.prev; }
  if (n.run >= COAST_RUN && m <= n.peak * COAST_DROP) n.done = wheelRelease(n, e.t);
  return n;
}
