// The app's appearance: dark, light, or whatever the system is set to (decision 133).

export type Theme = 'dark' | 'light' | 'system';
export const THEMES: readonly Theme[] = ['dark', 'light', 'system'];

/** A stored value as a theme; anything else is dark, the app's first look. */
export function cleanTheme(v: unknown): Theme {
  return v === 'light' || v === 'system' ? v : 'dark';
}

/** The look in effect: `system` follows the OS. */
export function effectiveTheme(theme: Theme, systemDark: boolean): 'dark' | 'light' {
  return theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;
}

/**
 * The window's own colours, which the page cannot paint: the backdrop shown before the page draws (the same as
 * --bg-canvas) and the caption buttons Windows draws over the title bar.
 */
export function windowColors(look: 'dark' | 'light'): { background: string; symbol: string } {
  return look === 'dark' ? { background: '#131316', symbol: '#a1a1a6' } : { background: '#ececf0', symbol: '#4c4c53' };
}

/** The top strip's height (--toolbar-h in tokens.css): the one row of the page the window's own buttons lie over. */
export const STRIP_H = 44;

/** What the window draws over the strip (Electron's titleBarOverlay). */
export interface WindowButtons { height: number; color?: string; symbolColor?: string }

/**
 * The window's own buttons, as tall as the top strip on every system (decision 245).
 * - Windows and Linux: the caption buttons in the look's colour, over nothing of their own.
 * - macOS: the traffic lights, where the system puts them from the left. A height and no position is what makes
 *   Electron centre them in that height, whatever their size on that macOS; with a position too it does not, and
 *   places them wrongly on macOS 26 (electron#49183). The page reads where they end (env(titlebar-area-x)).
 */
export function windowButtons(platform: string, look: 'dark' | 'light'): WindowButtons {
  return platform === 'darwin' ? { height: STRIP_H } : { height: STRIP_H, color: '#00000000', symbolColor: windowColors(look).symbol };
}
