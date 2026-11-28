// The next waiting item (T-0180, spec 2B · 2bA): the strip's Next button and Ctrl/Cmd+I go through the decisions
// that wait for the user, in the inbox's order; the taskbar and the Dock carry their count.

/**
 * The decision Next (dir 1) or Previous (dir -1) goes to. `ids`: the waiting ones in the inbox's order. `sel`: the
 * card selected in the inbox. `last`: where the previous press went. A selected card not yet gone to is the first
 * stop either way; from there each press steps on, round the ends. Null when nothing waits.
 */
export function stepWaiting(ids: readonly string[], sel: string | null, last: string | null, dir: 1 | -1): string | null {
  if (!ids.length) return null;
  const at = sel ? ids.indexOf(sel) : -1;
  if (at >= 0 && sel !== last) return sel;
  if (at < 0) return dir > 0 ? ids[0] : ids[ids.length - 1];
  return ids[(at + dir + ids.length) % ids.length];
}

/** The text of a count badge: nothing at 0, the number up to 9, then 9+. */
export const badgeText = (n: number) => (n <= 0 ? '' : n > 9 ? '9+' : String(Math.floor(n)));
