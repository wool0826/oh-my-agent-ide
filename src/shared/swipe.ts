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
