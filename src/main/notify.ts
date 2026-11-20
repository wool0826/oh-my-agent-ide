import fs from 'node:fs';
import path from 'node:path';
import { BrowserWindow, Notification, app } from 'electron';
import { loadSettings } from './settings';

let win: BrowserWindow | null = null;
export function setWindow(w: BrowserWindow) { win = w; }

/**
 * A decision is needed: the renderer plays the chosen sound and blinks the sidebar,
 * then an OS notification, taskbar flash (Windows) or Dock bounce (macOS).
 * The OS notification is silent because the app plays its own sound.
 */
export function notifyDecision(title: string, body: string) {
  win?.webContents.send('decision-alert');
  if (win && !win.isFocused()) {
    win.flashFrame(true);
    if (process.platform === 'darwin') app.dock?.bounce('informational');
  }
  if (!loadSettings().notifications || !Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: true });
  n.on('click', () => { win?.show(); win?.focus(); });
  n.show();
}

export function notifyInfo(title: string, body: string) {
  if (!loadSettings().notifications || win?.isFocused()) return;
  if (Notification.isSupported()) new Notification({ title, body, silent: true }).show();
}

const MIME: Record<string, string> = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac' };

/** A custom sound file as a data URL so the sandboxed renderer can play it. */
export function soundData(file: string): string | null {
  const mime = MIME[path.extname(file).toLowerCase()];
  if (!mime || !fs.existsSync(file)) return null;
  const st = fs.statSync(file);
  if (st.size > 8 * 1024 * 1024) return null;
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
}

export const SOUND_EXTS = Object.keys(MIME).map((e) => e.slice(1));
