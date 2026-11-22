// A small always-on-top box, opened by a system-wide shortcut, that sends one line to the Dispatcher (decision 123).

import path from 'node:path';
import { BrowserWindow, globalShortcut, screen } from 'electron';
import { loadSettings } from './settings';
import { normalizeQuickKey } from '../shared/quickKey';
import { log } from './log';

let box: BrowserWindow | null = null;
let registered = '';

function create(here: string) {
  box = new BrowserWindow({
    width: 640, height: 68, show: false, frame: false, transparent: true, resizable: false, maximizable: false, minimizable: false,
    fullscreenable: false, alwaysOnTop: true, skipTaskbar: true, hasShadow: false, title: 'Oh My Agent IDE',
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  box.loadFile(path.join(here, 'renderer', 'quick.html'));
  // Clicking anywhere else puts it away, like a launcher.
  box.on('blur', () => box?.hide());
  box.on('closed', () => { box = null; });
}

/** Shows the box near the top of the display the pointer is on. */
export function openQuick(here: string) {
  if (!box) create(here);
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const [w] = box!.getSize();
  box!.setPosition(Math.round(area.x + (area.width - w) / 2), Math.round(area.y + area.height * 0.22));
  box!.show();
  box!.focus();
}

export function closeQuick() { box?.hide(); }
export function destroyQuick() { box?.destroy(); box = null; }

/**
 * Registers the shortcut from the settings, replacing the one before. False when the key is set but the
 * system would not give it (another app holds it).
 */
export function syncQuickKey(here: string): boolean {
  const key = normalizeQuickKey(loadSettings().quickKey) ?? '';
  if (key === registered) return true;
  if (registered) globalShortcut.unregister(registered);
  registered = '';
  if (!key) return true;
  let ok = false;
  try { ok = globalShortcut.register(key, () => openQuick(here)); } catch (e) { log.warn('quick key', (e as Error).message); }
  if (ok) registered = key;
  return ok;
}

export function releaseQuickKey() {
  if (registered) globalShortcut.unregister(registered);
  registered = '';
}
