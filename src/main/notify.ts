import { BrowserWindow, Notification, app } from 'electron';
import { loadSettings } from './settings';

let win: BrowserWindow | null = null;
export function setWindow(w: BrowserWindow) { win = w; }

/** 결정이 필요할 때: OS 알림, 작업 표시줄 깜빡임(Windows), Dock 바운스(macOS), 앱 안 깜빡임. */
export function notifyDecision(title: string, body: string) {
  win?.webContents.send('blink');
  if (!loadSettings().notifications) return;
  if (win && !win.isFocused()) {
    win.flashFrame(true);
    if (process.platform === 'darwin') app.dock?.bounce('informational');
  }
  if (Notification.isSupported()) {
    const n = new Notification({ title, body, silent: false });
    n.on('click', () => { win?.show(); win?.focus(); });
    n.show();
  }
}

export function notifyInfo(title: string, body: string) {
  if (!loadSettings().notifications || win?.isFocused()) return;
  if (Notification.isSupported()) new Notification({ title, body, silent: true }).show();
}
