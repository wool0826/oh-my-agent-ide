// The tray icon: the app keeps working with its window closed, and this is the way back to it (decision 117).

import { Menu, Tray, app, nativeImage, type BrowserWindow } from 'electron';
import { t } from './i18n';
import { trayLines, type TrayCounts } from '../shared/tray';
import { log } from './log';
import { trayIconFile } from '../shared/appIcon';

let tray: Tray | null = null;
let last = '';

function icon() {
  const file = trayIconFile({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() });
  const size = process.platform === 'darwin' ? 18 : 16;
  return nativeImage.createFromPath(file).resize({ width: size, height: size, quality: 'best' });
}

function lineText(k: ReturnType<typeof trayLines>[number], c: TrayCounts) {
  return k === 'decisions' ? t('tray.decisions', { n: c.decisions }) : k === 'running' ? t('tray.running', { n: c.running }) : k === 'queued' ? t('tray.queued', { n: c.queued }) : t('tray.none');
}

/** Creates the icon once, then keeps its tooltip and menu in step with what is going on. */
export function updateTray(c: TrayCounts, show: () => void, quit: () => void) {
  const lines = trayLines(c).map((k) => lineText(k, c));
  const key = lines.join('|');
  if (!tray) {
    try {
      tray = new Tray(icon());
    } catch (e) {
      log.warn('no tray icon', e);
      return; // no tray on this desktop: the window's own close then quits as before
    }
    tray.on('click', show);
    last = '';
  }
  if (key === last) return;
  last = key;
  tray.setToolTip(`Oh My Agent IDE\n${lines.join('\n')}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    ...lines.map((label) => ({ label, enabled: false })),
    { type: 'separator' as const },
    { label: t('tray.open'), click: show },
    { label: t('tray.quit'), click: quit },
  ]));
  if (process.platform === 'darwin') app.setBadgeCount(c.decisions);
}

export const hasTray = () => !!tray;

/** Shows the window again, from the tray or a second launch. */
export function showWindow(win: BrowserWindow | null) {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
