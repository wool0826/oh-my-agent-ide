/** Where a context menu goes. */

export const MENU_EDGE = 8;

/** A menu of size w×h opened at (x, y): its corner is there, moved back as far as needed to stay `edge` inside the window. */
export function menuPlace(x: number, y: number, w: number, h: number, vw: number, vh: number, edge = MENU_EDGE): { left: number; top: number } {
  const fit = (v: number, size: number, room: number) => Math.round(Math.max(edge, Math.min(v, room - size - edge)));
  return { left: fit(x, w, vw), top: fit(y, h, vh) };
}
