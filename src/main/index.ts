import { app, BrowserWindow, Notification, ipcMain, shell, dialog, nativeTheme } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSettings, updateSettings, settingsView, saveSettings } from './settings';
import { ensureHome, paths } from './paths';
import { store } from './store';
import { accounts } from './accounts';
import { initMemory, listMemory, readMemory, writeMemory, searchMemoryPage, revisePreference, remember, memoryEvents, memorySync, syncMemory } from './memory';
import { registerRepo, removeRepo, updateRepo, listIssues } from './repos';
import { installPlugin } from './runtime';
import { answer as answerDecision, onDecisionCreated, onLateAnswer, pruneDecisions, withdraw } from './decisions';
import { dispatcher, createTask, assignedEvent } from './agents/dispatcher';
import { workers } from './agents/workers';
import { dismissSuggestion, saveSuggestion, suggestFromCorrection, suggestFromDecision } from './agents/memorySuggest';
import { runs } from './runs';
import { automations } from './automations';
import { PICK_MESSAGE, canPick } from '../shared/compare';
import type { AutoTrigger } from '../shared/types';
import { startPrMonitor, checkPrs, checkPrsSoon, mergePr } from './prmonitor';
import { notifyDecision, setWindow, soundData, SOUND_EXTS } from './notify';
import { notifyActions } from '../shared/notifyActions';
import { attachmentBlock, registerAttachments } from './attachments';
import { t } from './i18n';
import { claudeHome, ruleFiles } from './claudeContext';
import { listModels, setSessionModelSource } from './models';
import { log } from './log';
import { month, nowIso, oneLine, uid } from './util';
import { cleanMemo } from '../shared/memos';
import { CHAT_SNAPSHOT, PAGE } from '../shared/paging';
import { ALLOW, ALLOW_TASK, DENY, type AccountPlan, type AppState, type ClaudeInfo, type SettingsView } from '../shared/types';
import { notifyText } from '../shared/askWhy';
import { workerDecisions } from '../shared/inbox';
import { HIDDEN_ARG, closeAction, trayCounts } from '../shared/tray';
import { hasTray, showWindow, updateTray } from './tray';
import { startUpdateCheck, checkUpdate, updateInfo } from './update';
import { notifyInfo } from './notify';
import { closeQuick, destroyQuick, openQuick, releaseQuickKey, syncQuickKey } from './quick';
import { QUICK_ARG } from '../shared/quickKey';
import { listJiraIssues, setJiraToken } from './jira';
import { fakeMode } from './fake';

const here = path.dirname(fileURLToPath(import.meta.url));
let win: BrowserWindow | null = null;
/** A real quit is under way (the tray's Quit, Cmd+Q, the OS): closing the window then closes it. */
let quitting = false;
/** The "still running" notice was shown in this run. */
let trayHinted = false;

/** The user's answer to a decision, from the inbox or a notification button. Set once the handlers exist. */
let answerByUser: (id: string, ans: string) => void = () => {};

/** A newer release was found: the gear and Settings show it, and one notification says so. */
function onUpdate(u: { version: string }) {
  pushState();
  notifyInfo(t('upd.title', { v: u.version }), t('upd.body'));
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
if (process.platform === 'win32') app.setAppUserModelId('dev.ohmyagent.ide');
// The decision sound must play even before the user has clicked anything.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

function snapshot(): AppState {
  const d = store.data;
  return {
    ready: true,
    // Fake agents need no account.
    setupNeeded: !fakeMode() && accounts.list().length === 0,
    settings: settingsView(),
    accounts: accounts.views(),
    repos: d.repos,
    workers: d.workers,
    tasks: d.tasks,
    decisions: d.decisions,
    autoAnswers: d.autoAnswers,
    memorySuggestions: loadSettings().memorySuggest ? d.memorySuggestions.filter((x) => x.status === 'pending') : [],
    chat: d.chat.slice(-CHAT_SNAPSHOT),
    // All of them, not only those in the chat snapshot, so the inspector's "Show more" reaches every one.
    results: d.chat.filter((c) => (c.kind === 'result' || (c.kind === 'error' && c.ref)) && !c.cleared),
    memos: d.memos ?? [],
    automations: automations.list(),
    runs: runs.views(),
    memorySync: memorySync(),
    update: updateInfo(),
    fake: fakeMode(),
    dispatcher: { busy: dispatcher.busy, contextTokens: d.dispatcher.contextTokens, accountId: d.dispatcher.accountId, statusText: dispatcher.statusText, spend: d.dispatcher.spend?.[month()] ?? null },
  };
}

let pushTimer: NodeJS.Timeout | null = null;
/** Continue work that a usage limit paused: Worker tasks, held messages, and the Dispatcher. */
function retryAfterLimits() {
  workers.retryQueued();
  dispatcher.retryHeld();
}

/** While a usage limit holds every account, wake up right after the first one resets. */
let limitTimer: NodeJS.Timeout | null = null;
function scheduleLimitRetry() {
  if (limitTimer) clearTimeout(limitTimer);
  limitTimer = null;
  const at = accounts.nextFreeAt();
  if (at === null) return;
  limitTimer = setTimeout(() => {
    limitTimer = null;
    retryAfterLimits();
    scheduleLimitRetry();
  }, Math.max(1_000, at - Date.now() + 5_000));
}

function pushState() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    win?.webContents.send('state', snapshot());
    syncTray();
  }, 120);
}

function createWindow() {
  const mac = process.platform === 'darwin';
  // The UI is dark only, but Windows paints the window frame from the system theme: in light mode the
  // outline turns light and a 1px #f3f3f3 strip shows on the left, right and bottom edges (on a monitor
  // whose DPI differs from the primary one). A dark native theme gives the frame dark colors too.
  if (process.platform === 'win32') nativeTheme.themeSource = 'dark';
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1040,
    minHeight: 640,
    title: 'Oh My Agent IDE',
    // Started by the OS at sign-in: stay in the tray until asked for.
    show: !(process.argv.includes(HIDDEN_ARG) && loadSettings().background),
    // Matches --canvas, so nothing flashes before the page paints its backdrop.
    backgroundColor: '#131316',
    titleBarStyle: mac ? 'hiddenInset' : 'hidden',
    // Inside the floating sidebar panel.
    trafficLightPosition: mac ? { x: 22, y: 22 } : undefined,
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
  // The quick message box: its texts, a send (the same as typing in the chat) and putting it away.
  handle('quick:text', () => ({ ph: t('quick.ph'), sent: t('quick.sent'), lang: loadSettings().language }));
  handle('quick:send', (text: string) => dispatcher.send(String(text), []));
  handle('quick:close', () => closeQuick());
  handle('dispatcher:compact', () => dispatcher.compact());
  handle('dispatcher:clear', () => dispatcher.clear());
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
  const userAnswer = (id: string, ans: string) => {
    const d = answerDecision(id, ans);
    if (!d) return;
    const shown = ans === ALLOW ? t(d.source === 'plan' ? 'plan.approve' : 'allow') : ans === ALLOW_TASK ? t('allowTask') : ans === DENY ? t('deny') : ans;
    const who = d.workerId ? `${d.workerId}: ` : '';
    store.chat('decision', `${who}${oneLine(d.title, 80)} → ${shown}`);
    if (d.source === 'dispatcher') dispatcher.decisionAnswered(d.title, ans);
    remember('decision', `${d.workerId ?? 'Dispatcher'}: ${oneLine(d.title, 160)} → ${shown}`);
    suggestFromDecision(d);
  };
  handle('decision:answer', userAnswer);
  answerByUser = userAnswer;
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
    suggestFromCorrection(a);
  });
  handle('suggest:save', (id: string, text?: string) => { const file = saveSuggestion(id, text); dispatcher.refreshContext(); return file; });
  handle('suggest:dismiss', (id: string) => dismissSuggestion(id));
  // A page of a Worker's conversation: the latest, or the one before line `before` (decision 85).
  handle('worker:log', (id: string, opts?: { before?: number; limit?: number }) => store.readLog(id, opts?.before, Math.min(opts?.limit ?? PAGE.log, 1000)));
  handle('chat:page', (before: string, limit?: number) => store.chatPage(before, Math.min(limit ?? PAGE.chat, 1000)));
  handle('worker:send', (id: string, text: string, files?: string[]) => {
    const body = text + attachmentBlock(registerAttachments(files ?? []));
    // While the Worker waits on the user, what is typed to it answers that decision, as the inbox's text field does (decision 93).
    const open = workerDecisions(store.data.decisions, id)[0];
    if (!open) return workers.send(id, 'user', body);
    userAnswer(open.id, body);
    return 'answered';
  });
  handle('worker:stop', (id: string) => workers.stop(id, 'user'));
  handle('task:cancel', (id: string) => workers.cancelTask(id, 'user'));
  handle('queue:clear', () => workers.clearQueue('user'));
  handle('worker:diff', (id: string) => workers.diff(id));
  handle('worker:checkpoints', (id: string) => workers.checkpoints(id));
  handle('worker:restore', (id: string, ref: string) => workers.restore(id, ref));
  handle('pr:merge', (taskId: string) => mergePr(taskId));
  handle('repo:issues', (name: string) => listIssues(name));
  handle('jira:issues', () => listJiraIssues());
  handle('jira:token', (token: string) => { setJiraToken(String(token ?? '')); pushState(); });
  // The user picked one of two attempts: it is told to open its PR, and the comparison is closed for both.
  handle('compare:pick', (taskId: string) => {
    const picked = store.task(taskId);
    if (!picked?.compare || picked.compare.picked || !canPick(picked) || !picked.workerId) return;
    for (const x of store.data.tasks) if (x.compare?.group === picked.compare.group) x.compare.picked = picked.id;
    store.chat('event', t('ev.comparePicked', { id: picked.workerId, title: picked.title }));
    store.changed();
    return workers.send(picked.workerId, 'user', PICK_MESSAGE);
  });
  handle('auto:add', (prompt: string, trigger: AutoTrigger) => { automations.add({ prompt, trigger }); });
  handle('auto:toggle', (id: string, on: boolean) => automations.setEnabled(id, on));
  handle('auto:remove', (id: string) => { automations.remove(id); });
  handle('worker:archive', (id: string) => { runs.stop(id); return workers.archive(id); });
  handle('run:start', (id: string) => runs.start(id));
  handle('run:stop', (id: string) => runs.stop(id));
  handle('run:clear', (id: string) => runs.clear(id));
  handle('worker:unarchive', async (id: string) => { const w = store.worker(id); if (w) await workers.unarchive(w); });
  handle('repo:add', (url: string, name?: string, description?: string) => registerRepo({ url, name, description }).then((r) => { dispatcher.refreshContext(); return r; }));
  handle('repo:remove', (name: string) => { removeRepo(name); dispatcher.refreshContext(); });
  handle('repo:update', (name: string, description: string, setup?: string, run?: string) => { updateRepo(name, { description, ...(setup === undefined ? {} : { setup: setup.trim() }), ...(run === undefined ? {} : { run: run.trim() }) }); dispatcher.refreshContext(); });
  handle('memory:list', () => listMemory());
  handle('memory:read', (p: string) => readMemory(p));
  handle('memory:write', (p: string, c: string) => { writeMemory(p, c); dispatcher.refreshContext(); });
  // Memos. A change to what is shared reaches the Dispatcher with its next message.
  handle('memo:add', (text: string) => {
    const clean = cleanMemo(text);
    if (!clean) return null;
    const at = nowIso();
    const memo = { id: uid(), text: clean, shared: false, createdAt: at, updatedAt: at };
    (store.data.memos ??= []).push(memo);
    store.changed();
    return memo.id;
  });
  handle('memo:update', (id: string, patch: { text?: string; shared?: boolean }) => {
    const memo = store.data.memos?.find((m) => m.id === id);
    if (!memo) return;
    const wasShared = memo.shared;
    if (patch.text !== undefined) {
      const clean = cleanMemo(patch.text);
      if (clean && clean !== memo.text) { memo.text = clean; memo.updatedAt = nowIso(); }
    }
    if (patch.shared !== undefined) memo.shared = !!patch.shared;
    store.changed();
    if (wasShared || memo.shared) dispatcher.refreshContext();
  });
  handle('memo:remove', (id: string) => {
    const memo = store.data.memos?.find((m) => m.id === id);
    if (!memo) return;
    store.data.memos = store.data.memos!.filter((m) => m.id !== id);
    store.changed();
    if (memo.shared) dispatcher.refreshContext();
  });
  handle('memory:sync', () => syncMemory());
  handle('memory:search', (q: string, offset?: number) => searchMemoryPage(q, Math.max(0, offset ?? 0), PAGE.memHits));
  handle('memory:promote', async (repoName: string) => {
    const repo = store.repo(repoName);
    if (!repo) throw new Error(t('err.noRepo', { name: repoName }));
    const notes = readMemory(`repos/${repo.name}.md`);
    // Goes to an idle Worker that knows the repository (src/shared/routing.ts), or a new one.
    const { task, worker, reused } = await createTask({
      title: t('task.promote', { name: repo.name }),
      kind: 'code',
      repo: repo.name,
      prompt: [
        `Below are notes about the ${repo.name} repository collected in IDE memory. Pick only the rules and conventions useful to anyone working in this repository and open a PR adding them to its CLAUDE.md.`,
        'Leave out personal preferences, one-off records, and anything already in CLAUDE.md. Follow the structure and tone of the existing CLAUDE.md; create one if it does not exist.',
        '',
        notes,
      ].join('\n'),
    });
    store.chat('event', assignedEvent(task, worker, !!reused));
    return task.id;
  });
  handle('settings:save', (patch: Partial<SettingsView>) => {
    const before = loadSettings();
    // Compared with the folder in use: changing it and back again needs no restart.
    const homeChanged = !!patch.home && patch.home !== paths().home;
    const langChanged = (!!patch.language && patch.language !== before.language)
      || (patch.claudeRules !== undefined && patch.claudeRules !== before.claudeRules)
      || (patch.claudeMemory !== undefined && patch.claudeMemory !== before.claudeMemory)
      || (!!patch.dispatcherEffort && patch.dispatcherEffort !== before.dispatcherEffort)
      || (!!patch.dispatcherModel && patch.dispatcherModel !== before.dispatcherModel)
      || (patch.effortPerTask !== undefined && patch.effortPerTask !== before.effortPerTask);
    const moreWorkers = patch.maxWorkers !== undefined && patch.maxWorkers > before.maxWorkers;
    const remoteChanged = patch.memoryRemote !== undefined && patch.memoryRemote.trim() !== before.memoryRemote.trim();
    const checkOn = patch.updateCheck === true && !before.updateCheck;
    updateSettings(patch);
    if (checkOn) void checkUpdate(onUpdate);
    const quickKeyOk = syncQuickKey(here);
    syncTray();
    syncLoginItem();
    if (langChanged) dispatcher.refreshContext();
    // A new address is tried at once, so a wrong one shows its error here and not at the next memory write.
    if (remoteChanged) void syncMemory();
    // A higher limit starts tasks waiting for a slot now; a lower one stops nothing that runs.
    if (moreWorkers) workers.fillSlots();
    pushState(); // apply changed settings (language, font) right away
    return { restart: homeChanged, quickKeyOk };
  });
  handle('repo:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
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
  handle('account:addChatgpt', async (label: string) => { const id = await accounts.addChatgpt(label); void listModels(0).then(pushState); return id; });
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
  handle('app:version', () => app.getVersion());
  // Settings > Models asks for a fresh list (at most a minute old), its Refresh button for a new one;
  // other callers take one up to 6 hours old.
  handle('models:list', (mode: 'cached' | 'fresh' | 'now') => listModels(mode === 'now' ? 0 : mode === 'fresh' ? 60_000 : 6 * 3600_000));
  handle('claude:info', (): ClaudeInfo => ({ home: claudeHome(), rules: ruleFiles(), memoryHome: path.join(claudeHome(), 'projects') }));
  handle('app:relaunch', () => { app.relaunch(); app.quit(); });
}

async function boot() {
  loadSettings();
  ensureHome();
  log.info('boot', paths().home);
  store.load();
  // The state file was unreadable: say what was done about it, once, where the user will see it.
  if (store.restoredFrom) {
    log.error('state file unreadable; restored from', store.restoredFrom);
    store.chat('error', store.restoredFrom === 'none' ? t('backup.lost') : t('backup.restored', { day: store.restoredFrom }));
  }
  store.backup();
  setInterval(() => store.backup(), 3600_000).unref();
  pruneDecisions();
  // Questions and permission requests from the last run are withdrawn; Workers ask again as they continue.
  for (const d of [...store.data.decisions]) if (d.status === 'pending' && d.source !== 'dispatcher') withdraw(d.id);
  memoryEvents.on('synced', pushState);
  memoryEvents.on('pulled', () => dispatcher.refreshContext());
  await initMemory();
  installPlugin();
  store.on('changed', pushState);
  accounts.on('changed', pushState);
  accounts.on('changed', scheduleLimitRetry);
  store.on('workerLog', (id, item) => win?.webContents.send('workerLog', id, item));
  // Worker news worth a turn of its own: the Dispatcher starts one by itself.
  store.on('wake', () => dispatcher.wake());
  onDecisionCreated((d) => {
    // Simple decisions carry their answers as buttons on the notification.
    const actions = notifyActions(d).map((a) => ({ text: 'key' in a.label ? t(a.label.key) : a.label.text, run: () => answerByUser(d.id, a.answer) }));
    notifyDecision(d.workerId ? t('noti.workerWaits', { id: d.workerId }) : t('noti.decision'), notifyText(d), actions);
  });
  onLateAnswer((d) => {
    if (d.workerId) {
      try { workers.send(d.workerId, 'user', `[User answer] Question: ${d.title}\nAnswer: ${d.answer}`); } catch (e) { log.warn('late answer', e); }
    }
  });
  accounts.startPolling();
  setSessionModelSource(async () => (await dispatcher.session?.supportedModels()) ?? null);
  void listModels(6 * 3600_000);
  workers.resumeAfterRestart();
  startPrMonitor();
  // A Worker that waits too long for an answer gives its slot to the queue (decision 118).
  setInterval(() => workers.sweepWaiting(), 30_000);
  startUpdateCheck(onUpdate);
  automations.start((text) => dispatcher.send(text));
  setInterval(retryAfterLimits, 2 * 60_000).unref();
  scheduleLimitRetry();
  setInterval(() => { workers.autoArchive(); pruneDecisions(); }, 60 * 60_000).unref();
  setTimeout(() => workers.autoArchive(), 60_000).unref();
}

const single = app.requestSingleInstanceLock();
if (!single) app.quit();
else {
  // A second launch shows the window; with --quick it opens the quick message box instead (for a launcher or a pinned shortcut).
  app.on('second-instance', (_e, argv) => { if (argv.includes(QUICK_ARG)) openQuick(here); else showWindow(win); });
  app.whenReady().then(async () => {
    registerIpc();
    try {
      await boot();
    } catch (e) {
      log.error('boot failed', e);
      dialog.showErrorBox(t('err.bootTitle'), String((e as Error).message));
    }
    createWindow();
    syncTray();
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
    automations.stop();
    workers.closeAll();
    dispatcher.close();
    store.flush();
    saveSettings();
  });
}
