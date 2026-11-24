/** One Tab stop for a set of choices (a tab list, a radio group, the messages of a thread): keys move inside it. */

/**
 * Where a key takes the focus from item `at` of `n`. ←/→ move along a row and wrap; ↑/↓ do the same when the set
 * is `vertical` too (a radio group). Home and End go to the ends. Null: the key is not one of these.
 */
export function rovingIndex(at: number, key: string, n: number, vertical = false): number | null {
  if (n <= 0) return null;
  const step = key === 'ArrowRight' || (vertical && key === 'ArrowDown') ? 1 : key === 'ArrowLeft' || (vertical && key === 'ArrowUp') ? -1 : 0;
  if (step) return at < 0 ? (step > 0 ? 0 : n - 1) : (at + step + n) % n;
  if (key === 'Home') return 0;
  if (key === 'End') return n - 1;
  return null;
}

/**
 * The message ↑/↓/Home/End go to in a thread of `n`. A thread has two ends: the keys stop there and do not wrap.
 * Null: the key is not one of these.
 */
export function threadIndex(at: number, key: string, n: number): number | null {
  if (n <= 0) return null;
  if (key === 'ArrowDown') return Math.min(n - 1, at + 1);
  if (key === 'ArrowUp') return Math.max(0, at < 0 ? n - 1 : at - 1);
  if (key === 'Home') return 0;
  if (key === 'End') return n - 1;
  return null;
}

/**
 * Where Tab goes inside a message with `stops` controls, from the message itself (-1) or its control `at`:
 * the index of a control, -1 for the message, or 'out' to leave the thread.
 */
export function messageTab(at: number, stops: number, back: boolean): number | 'out' {
  if (back) return at < 0 ? 'out' : at - 1;
  return at + 1 < stops ? at + 1 : 'out';
}

/**
 * After a thread is drawn again, the message that was at `at` of `n`: the same place from the start when items were
 * added at the end, from the end when a page went in above.
 */
export function sameMessage(at: number, n: number, now: number, older: boolean): number {
  const i = older ? now - (n - at) : at;
  return now <= 0 ? -1 : Math.max(0, Math.min(now - 1, i));
}
