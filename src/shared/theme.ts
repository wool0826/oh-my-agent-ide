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
