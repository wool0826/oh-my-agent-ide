/* eslint-disable @typescript-eslint/no-explicit-any -- IPC handlers take what the window sends; each checks its own arguments. */
import { ipcMain, type BrowserWindow } from 'electron';
import { log } from '../log';
import type { AppState } from '../../shared/types';
import type { StateSender } from '../../shared/stateSync';

/** One channel the window calls: its value as `{ ok, value }`, or the error's message as `{ ok: false, error }`. */
export function handle(channel: string, fn: (...args: any[]) => any) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (e) {
      log.error(`ipc ${channel}`, e);
      return { ok: false, error: (e as Error).message };
    }
  });
}

/** A channel the window sends to without waiting for an answer (keys typed into the terminal); an error is only logged. */
export function listen(channel: string, fn: (...args: any[]) => void) {
  ipcMain.on(channel, (_e, ...args) => {
    try { fn(...args); } catch (e) { log.error(`ipc ${channel}`, e); }
  });
}

/** What the handlers need from main/index.ts: the window, the state push and the parts that follow the settings. */
export interface IpcContext {
  /** The folder of the built main script (for the quick message box's page). */
  here: string;
  win: () => BrowserWindow | null;
  snapshot: () => AppState;
  sender: StateSender;
  pushState: () => void;
  applyTheme: () => void;
  syncTray: () => void;
  syncLoginItem: () => void;
  syncAwake: () => void;
}
