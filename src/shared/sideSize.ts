// How big the side question panel is (T-0061): the size the user dragged it to, kept within limits and within the
// chat it floats over. Null in a direction means the panel's own size there (CSS: 420 wide, as tall as its thread).

export interface SideSize { w: number | null; h: number | null }
/** The room the panel has: the chat's width and height less its margins. */
export interface SideRoom { w: number; h: number }

export const SIDE_MIN = { w: 320, h: 220 } as const;
/** One arrow key press; with Shift, four. */
export const SIDE_STEP = 16;

const clampTo = (v: number, min: number, max: number) => Math.round(Math.max(min, Math.min(Math.max(min, max), v)));

/** Kept within the limits and the room; the room shrinking below the minimum leaves the minimum. */
export function clampSideSize(s: SideSize, room: SideRoom): SideSize {
  return {
    w: s.w == null ? null : clampTo(s.w, SIDE_MIN.w, room.w),
    h: s.h == null ? null : clampTo(s.h, SIDE_MIN.h, room.h),
  };
}

/** A stored size ("560x480", either side may be empty), or the panel's own size when there is none. */
export function parseSideSize(raw: string | null | undefined): SideSize {
  const m = /^(\d*)x(\d*)$/.exec(raw ?? '');
  const n = (v: string | undefined) => (v ? Math.max(0, Number(v)) : null);
  return m ? { w: n(m[1]), h: n(m[2]) } : { w: null, h: null };
}

export const sideSizeText = (s: SideSize) => `${s.w ?? ''}x${s.h ?? ''}`;

/**
 * The panel sits in the chat's bottom-right corner and grows from its top-left one: ← and ↑ make it bigger,
 * → and ↓ smaller. `now` is its size on screen. Null for any other key.
 */
export function keySideSize(key: string, shift: boolean, now: SideRoom, room: SideRoom): SideSize | null {
  const step = SIDE_STEP * (shift ? 4 : 1);
  const d = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[key];
  if (!d) return null;
  return clampSideSize({ w: now.w + d[0], h: now.h + d[1] }, room);
}
