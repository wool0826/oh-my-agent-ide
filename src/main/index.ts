import { app, BrowserWindow, ipcMain, shell, dialog, nativeTheme } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSettings, updateSettings, settingsView, saveSettings } from './settings';
import { ensureHome, paths } from './paths';
import { store } from './store';
import { accounts } from './accounts';
import { initMemory, listMemory, readMemory, writeMemory, searchMemory, revisePreference, remember } from './memory';
import { registerRepo, removeRepo, updateRepo } from './repos';
import { installPlugin } from './runtime';
import { answer as answerDecision, onDecisionCreated, onLateAnswer, pruneDecisions, withdraw } from './decisions';
import { dispatcher, createTask } from './agents/dispatcher';
import { workers } from './agents/workers';
import { startPrMonitor, checkPrs, checkPrsSoon } from './prmonitor';
import { notifyDecision, setWindow, soundData, SOUND_EXTS } from './notify';
import { attachmentBlock, registerAttachments } from './attachments';
import { t } from './i18n';
import { log } from './log';
import { nowIso, oneLine } from './util';
import { ALLOW, DENY, type AccountPlan, type AppState, type SettingsView } from '../shared/types';

const here = path.dirname(fileURLToPath(import.meta.url));
let win: BrowserWindow | null = null;

// Tests or a second profile: keep settings and data in another folder.
if (process.env.OMA_DATA_DIR) app.setPath('userData', path.resolve(process.env.OMA_DATA_DIR));
// Windows shows toast notifications only for an app with an AppUserModelID (same as build.appId).
if (process.platform === 'win32') app.setAppUserModelId('dev.ohmyagent.ide');
// The decision sound must play even before the user has clicked anything.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

function snapshot(): AppState {
  const d = store.data;
  return {
    ready: true,
    setupNeeded: accounts.list().length === 0,
    settings: settingsView(),
    accounts: accounts.views(),
    repos: d.repos,
    workers: d.workers,
    tasks: d.tasks,
    decisions: d.decisions,
    autoAnswers: d.autoAnswers,
    chat: d.chat.slice(-400),
    dispatcher: { busy: dispatcher.busy, contextTokens: d.dispatcher.contextTokens, accountId: d.dispatcher.accountId, statusText: dispatcher.statusText },
  };
}

let pushTimer: NodeJS.Timeout | null = null;
function pushState() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    win?.webContents.send('state', snapshot());
  }, 120);
}

function createWindow() {
  const mac = process.platform === 'darwin';
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1040,
    minHeight: 640,
    title: 'Oh My Agent IDE',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e20' : '#f5f5f7',
    titleBarStyle: mac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: mac ? { x: 16, y: 16 } : undefined,
    titleBarOverlay: mac ? undefined : { color: '#00000000', symbolColor: '#a1a1a6', height: 44 },
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  setWindow(win);
  win.loadFile(path.join(here, 'renderer', 'index.html'));
  win.on('focus', () => { win?.flashFrame(false); checkPrsSoon(); });
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

function handle(channel: string, fn: (...args: any[]) => any) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (e) {
      log.error(`ipc ${channel}`, e);
      return { ok: false, error: (e as Error).message };
    }
  });
}

function registerIpc() {
  handle('state', () => snapshot());
  handle('chat:send', (text: string, files?: string[]) => dispatcher.send(text, files ?? []));
  handle('chat:stop', () => dispatcher.stop());
  handle('chat:clear', (kind: 'result' | 'auto') => {
    if (kind === 'auto') store.data.autoAnswers.forEach((a) => { a.cleared = true; });
    else store.data.chat.forEach((c) => { if (c.kind === 'result' || c.kind === 'error') c.cleared = true; });
    store.changed();
  });
  handle('chat:unclear', (kind: 'result' | 'auto', ids: string[]) => {
    const set = new Set(ids);
    if (kind === 'auto') store.data.autoAnswers.forEach((a) => { if (set.has(a.id)) a.cleared = false; });
    else store.data.chat.forEach((c) => { if (set.has(c.id)) c.cleared = false; });
    store.changed();
  });
  handle('decision:answer', (id: string, ans: string) => {
    const d = answerDecision(id, ans);
    if (!d) return;
    const shown = ans === ALLOW ? t('allow') : ans === DENY ? t('deny') : ans;
    const who = d.workerId ? `${d.workerId}: ` : '';
    store.chat('decision', `${who}${oneLine(d.title, 80)} → ${shown}`);
    if (d.source === 'dispatcher') dispatcher.decisionAnswered(d.title, ans);
    remember('decision', `${d.workerId ?? 'Dispatcher'}: ${oneLine(d.title, 160)} → ${shown}`);
  });
  handle('auto:correct', (id: string, newAnswer: string, scope: 'once' | 'preference') => {
    const a = store.data.autoAnswers.find((x) => x.id === id);
    if (!a) throw new Error(t('err.noItem'));
    a.corrected = { answer: newAnswer, scope, at: nowIso() };
    store.chat('event', t(scope === 'preference' ? 'ev.correctedPref' : 'ev.corrected', { q: oneLine(a.question, 60), a: newAnswer }));
    if (scope === 'preference') revisePreference(a.basis, `${oneLine(a.question, 120)} → ${newAnswer}`);
    try {
      workers.send(a.workerId, 'user', `[Correction] For "${a.question}" the Dispatcher answered "${a.answer}" on the user's behalf, but the user corrected it to "${newAnswer}". Adjust anything you already did accordingly.`);
    } catch (e) {
      store.chat('error', t('err.correction', { id: a.workerId, msg: (e as Error).message }));
    }
    store.changed();
  });
  handle('worker:log', (id: string) => store.readLog(id));
  handle('worker:send', (id: string, text: string, files?: string[]) => workers.send(id, 'user', text + attachmentBlock(registerAttachments(files ?? []))));
  handle('worker:stop', (id: string) => workers.stop(id));
  handle('worker:archive', (id: string) => workers.archive(id));
  handle('worker:unarchive', async (id: string) => { const w = store.worker(id); if (w) await workers.unarchive(w); });
  handle('repo:add', (url: string, name?: string, description?: string) => registerRepo({ url, name, description }).then((r) => { dispatcher.refreshContext(); return r; }));
  handle('repo:remove', (name: string) => { removeRepo(name); dispatcher.refreshContext(); });
  handle('repo:update', (name: string, description: string) => { updateRepo(name, { description }); dispatcher.refreshContext(); });
  handle('memory:list', () => listMemory());
  handle('memory:read', (p: string) => readMemory(p));
  handle('memory:write', (p: string, c: string) => { writeMemory(p, c); dispatcher.refreshContext(); });
  handle('memory:search', (q: string) => searchMemory(q, 30));
  handle('memory:promote', async (repoName: string) => {
    const repo = store.repo(repoName);
    if (!repo) throw new Error(t('err.noRepo', { name: repoName }));
    const notes = readMemory(`repos/${repo.name}.md`);
    const owner = store.data.workers
      .filter((w) => w.repo === repo.name && w.status !== 'archived')
      .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))[0];
    const { task, worker } = await createTask({
      title: t('task.promote', { name: repo.name }),
      kind: 'code',
      repo: repo.name,
      worker_id: owner?.id,
      prompt: [
        `Below are notes about the ${repo.name} repository collected in IDE memory. Pick only the rules and conventions useful to anyone working in this repository and open a PR adding them to its CLAUDE.md.`,
        'Leave out personal preferences, one-off records, and anything already in CLAUDE.md. Follow the structure and tone of the existing CLAUDE.md; create one if it does not exist.',
        '',
        notes,
      ].join('\n'),
    });
    store.chat('event', t('ev.assigned', { id: worker.id, title: task.title }));
    return task.id;
  });
  handle('settings:save', (patch: Partial<SettingsView>) => {
    const before = loadSettings();
    const homeChanged = !!patch.home && patch.home !== before.home;
    const langChanged = (!!patch.language && patch.language !== before.language)
      || (!!patch.dispatcherEffort && patch.dispatcherEffort !== before.dispatcherEffort)
      || (patch.effortPerTask !== undefined && patch.effortPerTask !== before.effortPerTask);
    updateSettings(patch);
    if (langChanged) dispatcher.refreshContext();
    pushState(); // apply changed settings (language, font) right away
    return { restart: homeChanged };
  });
  handle('settings:pickHome', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('sound:pick', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openFile'], filters: [{ name: 'Audio', extensions: SOUND_EXTS }] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('sound:data', (file: string) => soundData(file));
  handle('account:add', (label: string, kind: 'token' | 'login', token: string, plan?: AccountPlan) => accounts.add(label, kind, token, plan));
  handle('account:remove', (id: string) => accounts.remove(id));
  handle('account:rename', (id: string, label: string) => accounts.rename(id, label));
  handle('account:plan', (id: string, plan: AccountPlan) => accounts.setPlan(id, plan));
  handle('account:refresh', () => accounts.refresh());
  handle('open:external', (url: string) => { if (/^https?:\/\//.test(url)) return shell.openExternal(url); });
  handle('open:path', async (p: string) => {
    const err = await shell.openPath(p);
    if (err) throw new Error(err);
  });
  handle('reveal:path', (p: string) => shell.showItemInFolder(p));
  handle('pr:check', () => checkPrs());
  handle('app:relaunch', () => { app.relaunch(); app.quit(); });
}

async function boot() {
  loadSettings();
  ensureHome();
  log.info('boot', paths().home);
  store.load();
  pruneDecisions();
  // Questions and permission requests from the last run are withdrawn; Workers ask again as they continue.
  for (const d of [...store.data.decisions]) if (d.status === 'pending' && d.source !== 'dispatcher') withdraw(d.id);
  await initMemory();
  installPlugin();
  store.on('changed', pushState);
  accounts.on('changed', pushState);
  store.on('workerLog', (id, item) => win?.webContents.send('workerLog', id, item));
  onDecisionCreated((d) => {
    notifyDecision(d.workerId ? t('noti.workerWaits', { id: d.workerId }) : t('noti.decision'), d.title);
  });
  onLateAnswer((d) => {
    if (d.workerId) {
      try { workers.send(d.workerId, 'user', `[User answer] Question: ${d.title}\nAnswer: ${d.answer}`); } catch (e) { log.warn('late answer', e); }
    }
  });
  accounts.startPolling();
  workers.resumeAfterRestart();
  startPrMonitor();
  setInterval(() => workers.retryQueued(), 2 * 60_000).unref();
  setInterval(() => { workers.autoArchive(); pruneDecisions(); }, 60 * 60_000).unref();
  setTimeout(() => workers.autoArchive(), 60_000).unref();
}

const single = app.requestSingleInstanceLock();
if (!single) app.quit();
else {
  app.on('second-instance', () => { win?.show(); win?.focus(); });
  app.whenReady().then(async () => {
    registerIpc();
    try {
      await boot();
    } catch (e) {
      log.error('boot failed', e);
      dialog.showErrorBox(t('err.bootTitle'), String((e as Error).message));
    }
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', () => {
    workers.closeAll();
    dispatcher.close();
    store.flush();
    saveSettings();
  });
}
