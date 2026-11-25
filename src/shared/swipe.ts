// Swiping a row of the right sidebar's list sideways: when a press becomes a sideways drag, how far a row that cannot
// be cleared gives, and whether letting go clears the row. The DOM part is in src/renderer/ui/swipe.ts.

/** How far the pointer moves before the drag counts as sideways or as a scroll. */
export const SWIPE_SLOP = 8;
/** Share of the row's width past which letting go clears it. */
export const SWIPE_SHARE = 0.35;
/** A flick: this fast (px/ms) and this far (px) toward one side clears it too. */
export const SWIPE_FLICK_SPEED = 0.6;
export const SWIPE_FLICK_MIN = 32;
/** The most a row that cannot be cleared gives (px). */
export const SWIPE_RESIST_MAX = 14;

/** What a press has become: not yet known, a sideways drag, or a scroll (the swipe never starts then). */
export function swipeIntent(dx: number, dy: number): 'wait' | 'swipe' | 'scroll' {
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (ax < SWIPE_SLOP && ay < SWIPE_SLOP) return 'wait';
  return ax > ay * 1.2 ? 'swipe' : 'scroll';
}

/** Where a row that cannot be cleared is drawn: it follows a little, then stops, as if held. */
export function swipeResist(dx: number): number {
  return Math.sign(dx) * SWIPE_RESIST_MAX * (1 - Math.exp(-Math.abs(dx) / 60));
}

/** Whether letting go at `dx`, moving at `v` px/ms, clears a row `width` wide. */
export function swipeClears(dx: number, v: number, width: number): boolean {
  if (!width || !dx) return false;
  if (Math.abs(dx) >= width * SWIPE_SHARE) return true;
  return Math.abs(dx) >= SWIPE_FLICK_MIN && Math.abs(v) >= SWIPE_FLICK_SPEED && Math.sign(v) === Math.sign(dx);
}

/** A two-finger swipe on a touchpad ends when no wheel event (its own or its momentum) has come for this long (ms). */
export const WHEEL_IDLE = 120;

/**
 * A touchpad swipe told by its wheel events: the row follows the fingers (`dx`, against the content's scroll, so it
 * goes the way the fingers go with natural scrolling and the way the drag goes), or it is a scroll and left alone.
 */
export interface WheelSwipe { mode: 'wait' | 'swipe' | 'scroll'; dx: number; dy: number }

export const wheelStart = (): WheelSwipe => ({ mode: 'wait', dx: 0, dy: 0 });

/** Adds one wheel event (`deltaMode` 1 is lines, 2 pages) to the gesture; once a scroll, it stays one. */
export function wheelStep(s: WheelSwipe, deltaX: number, deltaY: number, deltaMode = 0, width = 0): WheelSwipe {
  const k = deltaMode === 1 ? 16 : deltaMode === 2 ? (width || 400) : 1;
  let dx = s.dx - deltaX * k;
  const dy = s.dy - deltaY * k;
  if (width) dx = Math.max(-width, Math.min(width, dx));
  const mode = s.mode === 'wait' ? swipeIntent(dx, dy) : s.mode;
  return { mode, dx, dy };
}
