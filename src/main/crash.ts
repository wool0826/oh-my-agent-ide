// Keeps the app alive through errors nothing caught and a window page that dies, and records both (T-0098, decision 201).
// Workers go on while the window is closed, so a silent death is the most expensive failure: every one is logged
// with its stack in data/crash.log, the state is written at once, and the next start says the last run ended badly.

import fs from 'node:fs';
import path from 'node:path';
import { app, dialog, ipcMain, type BrowserWindow } from 'electron';
import { paths } from './paths';
import { flushNow } from './store';
import { log } from './log';
import { t } from './i18n';
import { fakeMode } from './fake';
import { exportDiagnostics } from './diagnostics';
import {
  crashEntry, faultAction, faultMessage, markerText, previousRun, relaunchArgs, relaunchedAt, rendererAction, rendererDied,
  RENDERER_LIMIT, type FaultKind, type RunMarker,
} from '../shared/crash';

/** Times of this run's uncaught exceptions. */
const exceptions: number[] = [];
/** This run wrote the marker (a second launch that only hands over to the first must not remove it). */
let began = false;
/** The run is leaving because of an error: the marker stays for the next start. */
let leaving = false;
let previous: RunMarker | null = null;
let marker: RunMarker | null = null;
let savedAt = 0;
const SAVE_GAP_MS = 5_000;
const CRASH_LOG_MAX = 1024 * 1024;

function record(kind: Parameters<typeof crashEntry>[0], what: unknown) {
  try {
    const file = paths().crashLog;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Kept small: a full log moves to crash.log.1 (the one before it goes), so a storm of errors cannot fill the disk.
    try { if (fs.statSync(file).size > CRASH_LOG_MAX) fs.renameSync(file, `${file}.1`); } catch { /* no log yet */ }
    fs.appendFileSync(file, crashEntry(kind, what, new Date()), 'utf8');
  } catch { /* the home folder may not exist yet */ }
}

/** Saves the state; after a rejection at most once every few seconds, so a storm of them does not stall the app. */
function save(kind: FaultKind) {
  const now = Date.now();
  if (kind === 'rejection' && now - savedAt < SAVE_GAP_MS) return;
  savedAt = now;
  flushNow();
}

function writeMarker() {
  if (!marker) return;
  try {
    fs.mkdirSync(path.dirname(paths().runMarker), { recursive: true });
    fs.writeFileSync(paths().runMarker, markerText(marker), 'utf8');
  } catch (e) { log.warn('run marker', e); }
}

function onFault(kind: FaultKind, what: unknown) {
  // A console whose reader went away: logging it would write to the same console and fail again.
  if ((what as { code?: string } | null)?.code === 'EPIPE') return;
  // The record and the save come first, each on its own, so a logger that fails cannot skip them.
  record(kind, what);
  try { save(kind); } catch { /* flushNow reports, never throws */ }
  try { log.error(kind === 'exception' ? 'uncaught exception' : 'unhandled rejection', what); } catch { /* still decided below */ }
  try {
    if (leaving) return;
    const now = Date.now();
    const action = faultAction(kind, exceptions, now, relaunchedAt(process.argv));
    if (kind === 'exception') exceptions.push(now);
    if (action === 'continue') return;
    leaving = true;
    if (marker) { marker.crash = { at: new Date(now).toISOString(), message: faultMessage(what) }; writeMarker(); }
    log.error(action === 'relaunch' ? 'repeated uncaught exceptions; relaunching' : 'repeated uncaught exceptions after a relaunch; quitting');
    if (action === 'relaunch') app.relaunch({ args: relaunchArgs(process.argv.slice(1), now) });
    else if (!fakeMode()) dialog.showErrorBox(t('crash.loopTitle'), faultMessage(what));
    app.quit();
    // A quit that hangs in a broken process is ended for good.
    setTimeout(() => app.exit(1), 5_000).unref();
  } catch { /* the handler must never throw itself */ }
}

/** Registers the process-wide handlers. Call once, before anything else runs. */
export function installCrashHandlers() {
  process.on('uncaughtException', (e) => onFault('exception', e));
  process.on('unhandledRejection', (e) => onFault('rejection', e));
  app.on('child-process-gone', (_e, d) => {
    if (d.reason === 'clean-exit') return;
    log.error('child process gone', d.type, d.reason, d.exitCode);
    record('child', `${d.type} ${d.reason} exit ${d.exitCode}${d.name ? ` (${d.name})` : ''}`);
  });
  // A run that quits removes its marker; one that leaves on an error keeps it.
  app.on('will-quit', clearMarker);
}

function clearMarker() {
  if (!began || leaving) return;
  try { fs.rmSync(paths().runMarker, { force: true }); } catch { /* gone already */ }
}

/** Reads what the last run left and leaves this run's marker. Call once, as the app starts. */
export function beginRun() {
  let text: string | null = null;
  try { text = fs.readFileSync(paths().runMarker, 'utf8'); } catch { /* the last run quit */ }
  previous = previousRun(text);
  if (previous) log.warn('the last run ended without quitting', previous.startedAt, previous.crash?.message ?? '');
  marker = { pid: process.pid, startedAt: new Date().toISOString(), version: app.getVersion() };
  began = true;
  writeMarker();
  // For the end-to-end tests, which cannot see a native dialog.
  if (fakeMode()) ipcMain.handle('crash:lastRun', () => ({ ok: true, value: previous }));
}

/** Says once, in a dialog, that the last run ended without quitting, and offers the diagnostics report. */
export async function noticeLastRun(win: () => BrowserWindow | null) {
  if (!previous || fakeMode()) return;
  const opts = {
    type: 'warning' as const,
    message: t('crash.lastTitle'),
    detail: previous.crash?.message ?? '',
    buttons: [t('crash.saveReport'), t('crash.close')],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
  // A window kept in the tray (started at sign-in) cannot hold a dialog that shows.
  const w = win()?.isVisible() ? win() : null;
  const r = w ? await dialog.showMessageBox(w, opts) : await dialog.showMessageBox(opts);
  if (r.response === 0) await exportDiagnostics(win()).catch((e) => log.warn('diagnostics', e));
}

/**
 * When the window's page dies, it is loaded again with the same state (main holds it; the page asks for it as it
 * loads). After RENDERER_LIMIT deaths within a minute it is left closed and a dialog offers reloading, the report,
 * or quitting.
 */
export function watchWindow(win: BrowserWindow, closing: () => boolean) {
  const deaths: number[] = [];
  // Windows ending the session (sign-out, shutdown) can stop the app without will-quit: that is a quit too.
  win.on('session-end', () => { flushNow(); clearMarker(); });
  win.webContents.on('render-process-gone', (_e, d) => {
    if (win.isDestroyed() || !rendererDied(d.reason, closing())) return;
    log.error('window page gone', d.reason, d.exitCode);
    record('renderer', `${d.reason} exit ${d.exitCode}`);
    const now = Date.now();
    const action = rendererAction(deaths, now);
    deaths.push(now);
    if (action === 'reload') { win.webContents.reload(); return; }
    void giveUp(win, deaths);
  });
}

async function giveUp(win: BrowserWindow, deaths: number[]) {
  for (;;) {
    const r = await dialog.showMessageBox({
      type: 'error',
      message: t('crash.pageTitle', { n: RENDERER_LIMIT }),
      buttons: [t('crash.reload'), t('crash.saveReport'), t('crash.quit')],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (win.isDestroyed()) return;
    if (r.response === 1) { await exportDiagnostics(null).catch((e) => log.warn('diagnostics', e)); continue; }
    if (r.response === 2) { app.quit(); return; }
    deaths.length = 0;
    win.webContents.reload();
    return;
  }
}
