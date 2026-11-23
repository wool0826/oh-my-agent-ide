import fs from 'node:fs';
import path from 'node:path';
import { BrowserWindow, Notification, app } from 'electron';
import { loadSettings } from './settings';
import { Burst, inQuietHours } from '../shared/notifyRules';

let win: BrowserWindow | null = null;
export function setWindow(w: BrowserWindow) { win = w; }

/** Notifications with buttons or a click are kept from garbage collection until they close, or those do nothing. */
const live = new Set<Notification>();

/**
 * A decision is needed: the renderer plays the chosen sound and blinks the sidebar,
 * then an OS notification, taskbar flash (Windows) or Dock bounce (macOS).
 * The OS notification is silent because the app plays its own sound.
 */
const bursts = new Burst();
/** Do-not-disturb hours are on now: no sound and no OS notification. The inbox, the tray and the taskbar still show it. */
const quiet = () => { const s = loadSettings(); return inQuietHours(s.quietFrom, s.quietTo, new Date()); };

/**
 * `source` is who asks (a Worker's id, or the Dispatcher). Several decisions from one source within a few seconds
 * are one burst: the first sounds and notifies, the rest only show in the inbox.
 */
export function notifyDecision(title: string, body: string, actions: { text: string; run: () => void }[] = [], source = 'dispatcher') {
  const loud = !quiet() && bursts.allow(`decision:${source}`, Date.now());
  // The sidebar blinks either way; the sound plays only when this one may be loud.
  win?.webContents.send('decision-alert', loud);
  if (win && !win.isFocused()) {
    win.flashFrame(true);
    if (loud && process.platform === 'darwin') app.dock?.bounce('informational');
  }
  if (!loud || !loadSettings().notifications || !Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: true, actions: actions.map((a) => ({ type: 'button' as const, text: a.text })) });
  n.on('click', () => { win?.show(); win?.focus(); });
  // A button answers the decision where it is; the window stays as it was.
  n.on('action', (_e, i) => { const index = typeof i === 'number' ? i : (i as { actionIndex: number }).actionIndex; actions[index]?.run(); });
  live.add(n);
  n.on('close', () => live.delete(n));
  n.show();
}

/**
 * A result or other news that needs no answer, under its own switch ("Notify when a task ends"). `source` groups a
 * burst, as for decisions. With `taskId`, a click opens the window on that task's result card.
 */
export function notifyInfo(title: string, body: string, source = title, taskId?: string) {
  const s = loadSettings();
  if (!s.notifyDone || win?.isFocused() || quiet() || !bursts.allow(`info:${source}`, Date.now())) return;
  showInfo(title, body, taskId);
}

/**
 * A task ended (done or failed): the task-end sound plays, focused window or not, as a decision's does; the OS
 * notification only while the window is not in front. Off with "Notify when a task ends", quiet in do-not-disturb
 * hours, and once per burst of one Worker.
 */
export function notifyTaskEnd(title: string, body: string, source: string, taskId: string) {
  if (!loadSettings().notifyDone || quiet() || !bursts.allow(`info:${source}`, Date.now())) return;
  win?.webContents.send('done-alert');
  if (!win?.isFocused()) showInfo(title, body, taskId);
}

function showInfo(title: string, body: string, taskId?: string) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: true });
  n.on('click', () => { win?.show(); win?.focus(); if (taskId) win?.webContents.send('open-result', taskId); });
  live.add(n);
  n.on('close', () => live.delete(n));
  n.show();
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
