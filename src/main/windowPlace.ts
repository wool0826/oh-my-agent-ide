// The window opens where the last run left it (5A); shared/windowState.ts decides where that is on today's screens.
import { BrowserWindow, screen } from 'electron';
import { store } from './store';
import { debounce } from './util';
import { boundsToKeep, parseWindowState, placeWindow, type Rect, type WindowState } from '../shared/windowState';

let kept: BrowserWindow | null = null;

/**
 * For the end-to-end tests, whose window starts hidden: shows it without the focus, moves it or maximizes it, and
 * says where it is and how it is shown.
 */
export function e2eWindow(op: { show?: boolean; bounds?: Rect; maximize?: boolean }) {
  const w = kept;
  if (!w || w.isDestroyed()) return null;
  if (op.show && !w.isVisible()) w.showInactive();
  if (op.bounds) w.setBounds(op.bounds);
  if (op.maximize) w.maximize();
  return { shown: w.isVisible(), bounds: w.getNormalBounds(), maximized: w.isMaximized() };
}

/** Where the window opens: the saved place fitted to the screens there are now. */
export function windowPlace(): WindowState {
  const saved = store.loaded ? parseWindowState(store.data.session?.window) : null;
  const primary = screen.getPrimaryDisplay().id;
  return placeWindow(saved, screen.getAllDisplays().map((d) => ({ workArea: d.workArea, primary: d.id === primary })));
}

/**
 * Maximizes or fills the screen as the last run did, once the window shows (it may start in the tray), and from
 * then on keeps where it is for the next start. A minimized window keeps the place it had before.
 */
export function keepWindowPlace(win: BrowserWindow, place: WindowState) {
  kept = win;
  // Windows makes a window on a scaled screen a few pixels bigger than asked; setting the bounds again is closer.
  win.setBounds(place.bounds);
  const opened = win.getNormalBounds();
  let shown = false;
  const restore = () => {
    shown = true;
    if (place.fullScreen) win.setFullScreen(true);
    else if (place.maximized) win.maximize();
  };
  if (win.isVisible()) restore(); else win.once('show', restore);
  const save = () => {
    if (!shown || win.isDestroyed() || win.isMinimized() || !store.loaded) return;
    store.saveSession({ window: { bounds: boundsToKeep(win.getNormalBounds(), opened, place.bounds), maximized: win.isMaximized(), fullScreen: win.isFullScreen() } satisfies WindowState });
  };
  const soon = debounce(save, 500);
  win.on('resize', soon);
  win.on('move', soon);
  win.on('maximize', soon);
  win.on('unmaximize', soon);
  win.on('enter-full-screen', soon);
  win.on('leave-full-screen', soon);
  win.on('close', save);
}
