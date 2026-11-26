// Where the window puts the macOS traffic lights. The page lays out around --lights-x/-w in tokens.css: the close
// button's left edge and the width of the three buttons as drawn. The collapsed rail centres that group.

/** --lights-x: the close button's drawn left edge, from the window's left edge. */
export const LIGHTS_X = 22;
/** --lights-w: three 12px buttons with 8px between them. */
export const LIGHTS_W = 3 * 12 + 2 * 8;
/** From the window's top edge, as before. */
export const LIGHTS_Y = 22;

/**
 * On macOS 26 the button frames have more room around the circles, so the drawn buttons start about 5px left of
 * (and above) the point given to trafficLightPosition. Measured on the user's Mac: in the 88px rail panel the
 * close button started 9px in and the zoom button ended 27px from the edge, with x 22.
 */
export const LIGHTS_PAD_26 = 5;

/** trafficLightPosition for a macOS version string such as `26.1` or `15.6.1`. */
export function trafficLightPosition(systemVersion: string): { x: number; y: number } {
  const major = Number.parseInt(systemVersion, 10);
  const pad = major >= 26 ? LIGHTS_PAD_26 : 0;
  return { x: LIGHTS_X + pad, y: LIGHTS_Y };
}
