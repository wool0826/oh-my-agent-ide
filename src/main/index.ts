import { app, BrowserWindow, Notification, shell, dialog, nativeTheme, protocol, powerSaveBlocker } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSettings, saveSettings } from './settings';
import { ensureHome, paths } from './paths';
import { store } from './store';
import { accounts } from './accounts';
import { initMemory, memoryEvents } from './memory';
import { repoEvents } from './repos';
import { installPlugin } from './runtime';
import { onDecisionCreated, onLateAnswer, pruneDecisions, withdraw } from './decisions';
import { dispatcher } from './agents/dispatcher';
import { workers } from './agents/workers';
import { runs } from './runs';
import { shell as shellRuns } from './shell';
import { terminal } from './terminal';
import { side } from './side';
import { automations } from './automations';
import { startPrMonitor, checkPrsSoon, prWatchChanged, resumeCiQuestion } from './prmonitor';
import { notifyDecision, notifyInfo, setWindow } from './notify';
import { notifyActions } from '../shared/notifyActions';
import { t } from './i18n';
import { listModels, setSessionModelSource } from './models';
import { log } from './log';
import { windowIconFile } from '../shared/appIcon';
import { LIGHTS_POSITION } from '../shared/trafficLights';
import { notifyText } from '../shared/askWhy';
import { HIDDEN_ARG, closeAction, trayCounts } from '../shared/tray';
import { hasTray, showWindow, updateTray } from './tray';
import { startUpdateCheck, holdInstallOnQuit } from './update';
import { awakeHolder, shouldStayAwake } from '../shared/awake';
import { autoSleep } from './sleep';
import { destroyQuick, openQuick, releaseQuickKey, syncQuickKey } from './quick';
import { QUICK_ARG } from '../shared/quickKey';
import { fakeMode } from './fake';
import { V1_ARG } from '../shared/stateSplit';
import { backToV1 } from './stateV1';
import { reportStateLoad } from './stateReport';
import { retryAfterLimits, scheduleLimitRetry } from './limits';
import { runPreflight } from './preflight';
import { fixToolPath } from './toolpath';
import { beginRun, installCrashHandlers, noticeLastRun, watchWindow } from './crash';
import { effectiveTheme, windowColors } from '../shared/theme';
import { SHOT_SCHEME } from '../shared/shots';
import { serveShots } from './shots';
import { StateSender } from '../shared/stateSync';
import { snapshot } from './snapshot';
import { registerIpc, registerE2eIpc, userAnswer } from './ipc';

const here = path.dirname(fileURLToPath(import.meta.url));
let win: BrowserWindow | null = null;
/** A real quit is under way (the tray's Quit, Cmd+Q, the OS): closing the window then closes it. */
let quitting = false;
/** The "still running" notice was shown in this run. */
let trayHinted = false;
/** Keeps the computer from sleeping (not the screen from dimming) while work runs; the same call on macOS and Windows. */
const awake = awakeHolder({ start: () => powerSaveBlocker.start('prevent-app-suspension'), stop: (id) => { if (powerSaveBlocker.isStarted(id)) powerSaveBlocker.stop(id); } });
const syncAwake = () => awake.sync(!quitting && shouldStayAwake({ on: loadSettings().keepAwake !== false, workers: store.data.workers, dispatcherBusy: dispatcher.busy }));

/** A newer release was found or downloaded: the gear and Settings show it, and one notification says so. */
const updateHooks = {
  changed: () => pushState(),
  found: (v: string, ready: boolean) => notifyInfo(t(ready ? 'upd.readyTitle' : 'upd.title', { v }), t(ready ? 'upd.readyBody' : 'upd.body')),
};

/**
 * The parts of the look the page cannot paint follow the theme: the native frame and menus (themeSource), the
 * backdrop behind the page, and on Windows the caption buttons over the title bar.
 */
function applyTheme() {
  const theme = loadSettings().theme;
  nativeTheme.themeSource = theme;
  const c = windowColors(effectiveTheme(theme, nativeTheme.shouldUseDarkColors));
  if (!win || win.isDestroyed()) return;
  win.setBackgroundColor(c.background);
  if (process.platform !== 'darwin') { try { win.setTitleBarOverlay({ color: '#00000000', symbolColor: c.symbol, height: 44 }); } catch { /* no overlay on this platform */ } }
}

function quitApp() {
  quitting = true;
  app.quit();
}

function syncTray() {
  if (!loadSettings().background) return;
  updateTray(trayCounts(store.data), () => showWindow(win), quitApp);
}

/** The OS starts the app hidden at sign-in when asked to. Only the installed app registers itself. */
function syncLoginItem() {
  if (!app.isPackaged) return;
  const on = loadSettings().openAtLogin;
  if (app.getLoginItemSettings({ args: [HIDDEN_ARG] }).openAtLogin !== on) app.setLoginItemSettings({ openAtLogin: on, args: [HIDDEN_ARG] });
}

// Tests or a second profile: keep settings and data in another folder.
if (process.env.OMA_DATA_DIR) app.setPath('userData', path.resolve(process.env.OMA_DATA_DIR));
// Windows shows toast notifications only for an app with an AppUserModelID (same as build.appId).
const APP_ID = 'dev.ohmyagent.ide';
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);
// The decision sound must play even before the user has clicked anything.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let pushTimer: NodeJS.Timeout | null = null;
/** What the window holds, so a push sends only the parts that changed since (shared/stateSync.ts). */
const sender = new StateSender();

function pushState() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    if (win) win.webContents.send('state', sender.next(snapshot()));
    syncTray();
  }, 120);
}

function createWindow() {
  const mac = process.platform === 'darwin';
  // Windows paints the window frame from the native theme, so it is set to the app's own: a dark app in a
  // light system otherwise gets a light outline and a 1px #f3f3f3 strip on its edges.
  nativeTheme.themeSource = loadSettings().theme;
  const look = windowColors(effectiveTheme(loadSettings().theme, nativeTheme.shouldUseDarkColors));
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    // Narrower than 1100 the right sidebar becomes a drawer, narrower than 960 the left one a rail (I1).
    minWidth: 760,
    minHeight: 640,
    title: 'Oh My Agent IDE',
    // Without it Windows has no icon for the taskbar button (a blank page under `electron .`).
    icon: mac ? undefined : windowIconFile({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() }, process.platform),
    // Started by the OS at sign-in: stay in the tray until asked for.
    show: !(process.argv.includes(HIDDEN_ARG) && loadSettings().background),
    // Matches --bg-canvas, so nothing flashes before the page paints its backdrop.
    backgroundColor: look.background,
    titleBarStyle: mac ? 'hiddenInset' : 'hidden',
    // Inside the floating sidebar panel (--lights-x in tokens.css, test/trafficLights.test.ts).
    trafficLightPosition: mac ? { ...LIGHTS_POSITION } : undefined,
    // macOS: `true` only reports the lights' box to the page (env(titlebar-area-*)); a height would move them (electron#49183).
    titleBarOverlay: mac ? true : { color: '#00000000', symbolColor: look.symbol, height: 44 },
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  setWindow(win);
  watchWindow(win, () => quitting);
  win.on('session-end', holdInstallOnQuit);
  // The AppUserModelID has no Start-menu shortcut when run with `electron .`, so the taskbar gets the icon and name from the window.
  if (process.platform === 'win32') win.setAppDetails({ appId: APP_ID, appIconPath: windowIconFile({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() }, 'win32'), relaunchDisplayName: 'Oh My Agent IDE' });
  void win.loadFile(path.join(here, 'renderer', 'index.html'));
  win.on('focus', () => { win?.flashFrame(false); checkPrsSoon(); });
  // With "keep running" on, closing the window hides it and the work goes on; the tray icon brings it back.
  win.on('close', (e) => {
    if (closeAction({ quitting, background: loadSettings().background && hasTray() }) !== 'hide') return;
    e.preventDefault();
    win?.hide();
    if (!trayHinted && loadSettings().notifications && Notification.isSupported()) {
      trayHinted = true;
      new Notification({ title: t('tray.stillTitle'), body: t('tray.stillBody'), silent: true }).show();
    }
  });
  // Windows (and Linux) report Back/Forward keys, and the side buttons of some mice, as app commands.
  // The page steps through its screen history; a press it also gets as a mouse event counts once (decision 81).
  win.on('app-command', (_e, cmd) => {
    if (cmd === 'browser-backward' || cmd === 'browser-forward') win?.webContents.send('nav', cmd === 'browser-backward' ? 'back' : 'forward');
  });
  // macOS hides the traffic lights in full screen, so the page drops the room it keeps for them.
  const sendFullScreen = () => win?.webContents.send('fullscreen', win.isFullScreen());
  win.on('enter-full-screen', sendFullScreen);
  // Setting the position again makes Electron send the lights' box to the page now, not at the next resize.
  win.on('leave-full-screen', () => { if (mac) win?.setWindowButtonPosition({ ...LIGHTS_POSITION }); sendFullScreen(); });
  win.webContents.on('did-finish-load', sendFullScreen);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  // Never navigate away from the app (a file dropped outside the composer would open it in the window).
  win.webContents.on('will-navigate', (e, url) => {
    e.preventDefault();
    if (/^https?:/.test(url)) void shell.openExternal(url);
  });
}

async function boot() {
  loadSettings();
  ensureHome();
  log.info('boot', paths().home);
  // Before anything runs gh, git, codex or claude: an app opened from the macOS Dock lacks the shell's PATH.
  await fixToolPath();
  store.load();
  shellRuns.settle();
  reportStateLoad();
  store.backup();
  setInterval(() => store.backup(), 3600_000).unref();
  pruneDecisions();
  // Questions and permission requests from the last run are withdrawn; Workers ask again as they continue.
  // The PR monitor's CI question has no Worker turn to ask it again, so it is waited for again instead.
  for (const d of [...store.data.decisions]) if (d.status === 'pending' && d.source !== 'dispatcher' && !resumeCiQuestion(d)) withdraw(d.id);
  memoryEvents.on('synced', pushState);
  memoryEvents.on('pulled', () => dispatcher.refreshContext());
  await initMemory();
  installPlugin();
  store.on('changed', pushState);
  store.on('changed', prWatchChanged);
  store.on('changed', syncAwake);
  syncAwake();
  // "Sleep when done": armed by the user only, never saved; it lets go of the keep-awake blocker before sleeping.
  autoSleep.init({ dispatcherBusy: () => dispatcher.busy, dispatcherDue: () => dispatcher.wakePending, release: () => awake.release(), pushState });
  store.on('changed', autoSleep.sync);
  repoEvents.on('progress', pushState);
  if (fakeMode()) registerE2eIpc(awake);
  accounts.on('changed', pushState);
  accounts.on('changed', scheduleLimitRetry);
  // An account switched back on (by hand or when its hour ends): work that waited for one goes on now.
  accounts.on('resumed', retryAfterLimits);
  store.on('workerLog', (id, item) => win?.webContents.send('workerLog', id, item));
  side.onChange((v) => win?.webContents.send('side-state', v));
  terminal.onChange((v) => win?.webContents.send('term-state', v));
  // Worker news worth a turn of its own: the Dispatcher starts one by itself.
  store.on('wake', () => dispatcher.wake());
  store.on('shell-done', () => dispatcher.shellDone());
  onDecisionCreated((d) => {
    // Simple decisions carry their answers as buttons on the notification.
    const actions = notifyActions(d).map((a) => ({ text: 'key' in a.label ? t(a.label.key) : a.label.text, run: () => userAnswer(d.id, a.answer) }));
    notifyDecision(d.workerId ? t('noti.workerWaits', { id: d.workerId }) : t('noti.decision'), notifyText(d), actions, d.workerId ?? 'dispatcher');
  });
  onLateAnswer((d) => {
    if (d.workerId) {
      workers.send(d.workerId, 'user', `[User answer] Question: ${d.title}\nAnswer: ${d.answer}`).catch((e) => log.warn('late answer', e));
    }
  });
  accounts.startPolling();
  setSessionModelSource(async () => (await dispatcher.session?.supportedModels()) ?? null);
  void listModels(6 * 3600_000);
  workers.resumeAfterRestart();
  startPrMonitor();
  // A Worker that waits too long for an answer gives its slot to the queue (decision 118).
  setInterval(() => { workers.sweepWaiting(); workers.sweepStalled(); }, 30_000);
  startUpdateCheck(updateHooks);
  // What the app needs on this computer: checked once the window is up, so a missing tool shows before a task fails on it.
  setTimeout(() => void runPreflight().then(() => pushState()).catch((e) => log.warn('preflight', e)), 3_000);
  automations.start((text) => dispatcher.send(text));
  setInterval(retryAfterLimits, 2 * 60_000).unref();
  scheduleLimitRetry();
  setInterval(() => { workers.autoArchive(); pruneDecisions(); }, 60 * 60_000).unref();
  setTimeout(() => workers.autoArchive(), 60_000).unref();
}

installCrashHandlers();
protocol.registerSchemesAsPrivileged([{ scheme: SHOT_SCHEME, privileges: { standard: true, secure: true } }]);
const single = app.requestSingleInstanceLock();
if (!single) app.quit();
else if (process.argv.includes(V1_ARG)) backToV1();
else {
  // A second launch shows the window; with --quick it opens the quick message box instead (for a launcher or a pinned shortcut).
  // One with --state-v1 wrote nothing back, because this app would write over it: the chat here says so.
  app.on('second-instance', (_e, argv) => {
    if (argv.includes(QUICK_ARG)) return openQuick(here);
    if (argv.includes(V1_ARG) && store.loaded) store.chat('error', t('state.v1Running'));
    showWindow(win);
  });
  void app.whenReady().then(async () => {
    registerIpc({ here, win: () => win, snapshot, sender, pushState, applyTheme, syncTray, syncLoginItem, syncAwake });
    serveShots();
    beginRun();
    try {
      await boot();
    } catch (e) {
      log.error('boot failed', e);
      dialog.showErrorBox(t('err.bootTitle'), String((e as Error).message));
    }
    createWindow();
    void noticeLastRun(() => win);
    syncTray();
    // With System chosen, the window's own colours follow the OS when it changes.
    nativeTheme.on('updated', () => { if (loadSettings().theme === 'system') applyTheme(); });
    syncLoginItem();
    if (!syncQuickKey(here)) log.warn('quick key not available', loadSettings().quickKey);
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); else showWindow(win); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', () => {
    quitting = true;
    releaseQuickKey();
    destroyQuick();
    runs.stopAll();
    shellRuns.stopAll();
    terminal.stopAll();
    side.reset();
    automations.stop();
    workers.closeAll();
    dispatcher.close();
    awake.release();
    store.flush();
    saveSettings();
  });
}
