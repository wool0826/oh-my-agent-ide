// The macOS traffic lights. The window puts the close button's frame at LIGHTS_POSITION; how wide and tall the three
// frames are is up to AppKit and differs between macOS versions. With titleBarOverlay on, Electron reports the box
// around them (the frames plus the position as a margin on every side) as env(titlebar-area-x/-height), and the page
// lays out from that box (styles.css: --lights-box-w/-h). The tokens below are only the fallback without it.

/** --lights-x: the close button's frame, from the window's left edge. Also the margin Electron adds after the zoom button. */
export const LIGHTS_X = 22;
/** From the window's top edge; the buttons sit in the middle of a box this much taller than them on both sides. */
export const LIGHTS_Y = 22;
/** --lights-w: fallback width of the three buttons (12px circles, 8px apart) when the window does not report its box. */
export const LIGHTS_W = 3 * 12 + 2 * 8;
/** The same on every macOS version: the layout follows the reported box, so nothing is shifted to make up for it. */
export const LIGHTS_POSITION = { x: LIGHTS_X, y: LIGHTS_Y } as const;

/** The box Electron reports (window points from the top left): env(titlebar-area-x) and env(titlebar-area-height). */
export interface LightsBox { w: number; h: number }
/** The tokens the layout reads, in px. */
export interface LightsTokens { lightsX: number; gap: number; inset: number; toolbarH: number; padMax: number }

/** Where things go around the lights, the way styles.css computes it from the box. */
export interface LightsLayout {
  /** The zoom button's right edge. */
  zoomRight: number;
  /** --lights-end: where content may start right of the lights (the Settings back button, a toolbar after the rail). */
  end: number;
  /** --rail-w: the collapsed sidebar column; its panel (inset to rail-w) has the box's centre as its own. */
  railW: number;
  /** Top padding of the toolbar rows, so their middle is the lights' middle (box h / 2). */
  toolbarPad: number;
}

export function lightsLayout(box: LightsBox, k: LightsTokens): LightsLayout {
  const zoomRight = box.w - k.lightsX;
  return {
    zoomRight,
    end: zoomRight + k.gap,
    railW: box.w - k.inset,
    toolbarPad: Math.min(k.padMax, Math.max(0, box.h - k.toolbarH)),
  };
}
