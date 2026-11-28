// The window opens where it was closed (5A): same screen, size and position, maximized or full screen as it was.
// A screen that is gone sends it to the middle of the main one, and a window bigger than its screen is fitted to it.

export interface Rect { x: number; y: number; width: number; height: number }

/** What is kept of the window between runs: its normal bounds (not the maximized ones) and how it was shown. */
export interface WindowState { bounds: Rect; maximized: boolean; fullScreen: boolean }

/** A screen as the window can use it: its work area leaves out the taskbar or the Dock. */
export interface Monitor { workArea: Rect; primary?: boolean }

export const WINDOW_DEFAULT = { width: 1320, height: 860 };
export const WINDOW_MIN = { width: 760, height: 640 };

/**
 * The bounds to keep for the next start. A scaled screen (150%) rounds the window's size a pixel or two when it is
 * made, so a window not moved or resized since it opened keeps the bounds it was placed at and does not grow at
 * each start.
 */
export function boundsToKeep(now: Rect, opened: Rect, placed: Rect): Rect {
  const same = (['x', 'y', 'width', 'height'] as const).every((k) => Math.abs(now[k] - opened[k]) <= 2);
  return same ? placed : now;
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The saved state, or null when there is none or it is not one. */
export function parseWindowState(v: unknown): WindowState | null {
  const o = v as Partial<WindowState> | null;
  const b = o?.bounds as Partial<Rect> | undefined;
  if (!b || !num(b.x) || !num(b.y) || !num(b.width) || !num(b.height) || b.width <= 0 || b.height <= 0) return null;
  return { bounds: { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) }, maximized: o?.maximized === true, fullScreen: o?.fullScreen === true };
}

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** `size` no bigger than the area, and not under the window's minimum unless the area itself is smaller. */
function fit(size: { width: number; height: number }, area: Rect) {
  return {
    width: Math.min(Math.max(size.width, Math.min(WINDOW_MIN.width, area.width)), area.width),
    height: Math.min(Math.max(size.height, Math.min(WINDOW_MIN.height, area.height)), area.height),
  };
}

function centre(size: { width: number; height: number }, area: Rect): Rect {
  const s = fit(size, area);
  return { x: area.x + Math.round((area.width - s.width) / 2), y: area.y + Math.round((area.height - s.height) / 2), ...s };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/**
 * Where the window opens on the screens there are now. It stays on the screen it covers most, moved and shrunk to lie
 * wholly inside it, so its top strip can always be grabbed. On no screen (the one it was on is unplugged) it opens in
 * the middle of the main screen at its saved size, fitted. With nothing saved it opens there at the default size.
 */
export function placeWindow(saved: WindowState | null, screens: Monitor[]): WindowState {
  const main = screens.find((s) => s.primary) ?? screens[0];
  if (!main) return { bounds: { x: 0, y: 0, ...WINDOW_DEFAULT }, maximized: false, fullScreen: false };
  if (!saved) return { bounds: centre(WINDOW_DEFAULT, main.workArea), maximized: false, fullScreen: false };
  const { bounds: b } = saved;
  let best: Monitor | null = null;
  let most = 0;
  for (const s of screens) {
    const o = overlap(b, s.workArea);
    if (o > most) { most = o; best = s; }
  }
  if (!best) return { ...saved, bounds: centre(b, main.workArea) };
  const a = best.workArea;
  const s = fit(b, a);
  const bounds = { x: clamp(b.x, a.x, a.x + a.width - s.width), y: clamp(b.y, a.y, a.y + a.height - s.height), ...s };
  return { ...saved, bounds };
}
