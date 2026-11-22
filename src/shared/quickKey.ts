// The system-wide shortcut that opens the quick message box (decision 123).

export const QUICK_KEY_DEFAULT = 'CommandOrControl+Shift+Space';
/** Starting the app again with this argument opens the box in the one already running. */
export const QUICK_ARG = '--quick';

const MODS: Record<string, string> = {
  ctrl: 'Control', control: 'Control', cmd: 'Command', command: 'Command', commandorcontrol: 'CommandOrControl', cmdorctrl: 'CommandOrControl',
  alt: 'Alt', option: 'Alt', shift: 'Shift', super: 'Super', meta: 'Super', win: 'Super',
};
const NAMED = new Set(['Space', 'Tab', 'Enter', 'Return', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown', 'Up', 'Down', 'Left', 'Right', 'Plus']);

/**
 * What the user typed as a shortcut, in Electron's spelling ("ctrl + shift + k" → "Control+Shift+K").
 * '' turns the shortcut off. null when it is not one: no key, two keys, or no modifier besides Shift,
 * which would take a plain key away from every other app.
 */
export function normalizeQuickKey(text: string): string | null {
  const parts = text.split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return text.trim() ? null : '';
  const mods: string[] = [];
  let key = '';
  for (const p of parts) {
    const mod = MODS[p.toLowerCase()];
    if (mod) { if (!mods.includes(mod)) mods.push(mod); continue; }
    if (key) return null;
    const named = [...NAMED].find((n) => n.toLowerCase() === p.toLowerCase());
    if (named) key = named;
    else if (/^[a-z0-9]$/i.test(p)) key = p.toUpperCase();
    else if (/^f([1-9]|1\d|2[0-4])$/i.test(p)) key = p.toUpperCase();
    else return null;
  }
  if (!key || !mods.some((m) => m !== 'Shift')) return null;
  const order = ['CommandOrControl', 'Command', 'Control', 'Alt', 'Shift', 'Super'];
  return [...mods.sort((a, b) => order.indexOf(a) - order.indexOf(b)), key].join('+');
}

/** The shortcut as the user reads it on this platform ("Ctrl+Shift+Space", "⌘⇧Space"). */
export function quickKeyLabel(key: string, mac: boolean): string {
  if (!key) return '';
  const parts = key.split('+');
  if (!mac) return parts.map((p) => (p === 'CommandOrControl' || p === 'Control' ? 'Ctrl' : p === 'Super' ? 'Win' : p)).join('+');
  const sym: Record<string, string> = { CommandOrControl: '⌘', Command: '⌘', Control: '⌃', Alt: '⌥', Shift: '⇧', Super: '⌘' };
  return parts.map((p) => sym[p] ?? p).join('');
}
