import { app, BrowserWindow, Notification, ipcMain, shell, dialog, nativeTheme, net, protocol } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadSettings, updateSettings, settingsView, saveSettings } from './settings';
import { ensureHome, paths } from './paths';
import { store } from './store';
import { accounts } from './accounts';
import { initMemory, listMemory, readMemory, writeMemory, searchMemoryPage, revisePreference, remember, memoryEvents, memorySync, syncMemory } from './memory';
import { registerRepo, removeRepo, updateRepo, listIssues, addingRepo, cancelAddRepo, repoEvents } from './repos';
import { opensSafely } from '../shared/openSafe';
import { installPlugin } from './runtime';
import { answer as answerDecision, onDecisionCreated, onLateAnswer, pruneDecisions, withdraw } from './decisions';
import { dispatcher, createTask, assignedEvent } from './agents/dispatcher';
import { workers } from './agents/workers';
import { dismissSuggestion, saveSuggestion, suggestFromCorrection, suggestFromDecision } from './agents/memorySuggest';
import { runs } from './runs';
import { shell as shellRuns } from './shell';
import { terminal } from './terminal';
import { addScript, removeScript, runScript, updateScript } from './scripts';
import type { ScriptInput } from '../shared/scripts';
import { side } from './side';
import { automations } from './automations';
import { PICK_MESSAGE, canPick } from '../shared/compare';
import type { AutoTrigger } from '../shared/types';
import { startPrMonitor, checkPrs, checkPrsNow, checkPrsSoon, prWatchChanged, queueMerge, resumeCiQuestion, runMergeQueue, unqueueMerge } from './prmonitor';
import { notifyDecision, setWindow, soundData, SOUND_EXTS } from './notify';
import { notifyActions } from '../shared/notifyActions';
import { attachmentBlock, registerAttachments, savePastedImage } from './attachments';
import { t } from './i18n';
import { claudeHome, ruleFiles } from './claudeContext';
import { listModels, setSessionModelSource } from './models';
import { log } from './log';
import { windowIconFile } from '../shared/appIcon';
import { month, nowIso, oneLine, uid } from './util';
import { cleanMemo } from '../shared/memos';
import { CHAT_SNAPSHOT, PAGE } from '../shared/paging';
import { ALLOW, ALLOW_TASK, DENY, type AccountPlan, type AppState, type ClaudeInfo, type SettingsView } from '../shared/types';
import { notifyText } from '../shared/askWhy';
import { answerTarget } from '../shared/inbox';
import { HIDDEN_ARG, closeAction, trayCounts } from '../shared/tray';
import { hasTray, showWindow, updateTray } from './tray';
import { startUpdateCheck, checkUpdate, updateView, applyUpdate, restartIntoUpdate, holdInstallOnQuit, followUpdateSetting } from './update';
import { applyBlockers } from '../shared/update';
import { notifyInfo } from './notify';
import { closeQuick, destroyQuick, openQuick, releaseQuickKey, syncQuickKey } from './quick';
import { QUICK_ARG } from '../shared/quickKey';
import { listJiraIssues, setJiraToken } from './jira';
import { fakeMode } from './fake';
import { V1_ARG } from '../shared/stateSplit';
import { rollbackToV1 } from './stateFiles';
import { lastPreflight, runPreflight } from './preflight';
import { fixToolPath } from './toolpath';
import { failedCount } from '../shared/preflight';
import { diagnostics, exportDiagnostics } from './diagnostics';
import { beginRun, installCrashHandlers, noticeLastRun, watchWindow } from './crash';
import { effectiveTheme, windowColors } from '../shared/theme';
import { SHOT_SCHEME, shotPath } from '../shared/shots';

const here = path.dirname(fileURLToPath(import.meta.url));
let win: BrowserWindow | null = null;
/** A real quit is under way (the tray's Quit, Cmd+Q, the OS): closing the window then closes it. */
let quitting = false;
/** The "still running" notice was shown in this run. */
let trayHinted = false;
/** With fake agents (the end-to-end tests), what would have been opened on the computer, kept instead. */
const e2eOpened: [string, string][] = [];

/** The user's answer to a decision, from the inbox or a notification button. Set once the handlers exist. */
let answerByUser: (id: string, ans: string) => void = () => {};

/** What a restart into a downloaded update would wait for. */
const updateBlockers = () => applyBlockers({ workers: store.data.workers, tasks: store.data.tasks, dispatcherBusy: dispatcher.busy });

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

function snapshot(): AppState {
  const d = store.data;
  return {
    ready: true,
    // Fake agents need no account; an end-to-end test of the first run asks for the account screen (OMA_E2E_NO_ACCOUNT).
    setupNeeded: (!fakeMode() || process.env.OMA_E2E_NO_ACCOUNT === '1') && accounts.list().length === 0,
    settings: settingsView(),
    accounts: accounts.views(),
    usageClock: accounts.clock,
    repos: d.repos,
    workers: d.workers,
    tasks: d.tasks,
    mergeQueue: d.mergeQueue ?? [],
    decisions: d.decisions,
    autoAnswers: d.autoAnswers,
    memorySuggestions: loadSettings().memorySuggest ? d.memorySuggestions.filter((x) => x.status === 'pending') : [],
    chat: d.chat.slice(-CHAT_SNAPSHOT),
    // All of them, not only those in the chat snapshot, so the inspector's "Show more" reaches every one.
    results: d.chat.filter((c) => (c.kind === 'result' || (c.kind === 'error' && c.ref)) && !c.cleared),
    memos: d.memos ?? [],
    automations: automations.list(),
    scripts: d.scripts ?? [],
    runs: runs.views(),
    memorySync: memorySync(),
    update: updateView(updateBlockers()),
    fake: fakeMode(),
    preflightFailed: failedCount(lastPreflight() ?? []),
    repoAdding: addingRepo(),
    dispatcher: { busy: dispatcher.busy, contextTokens: d.dispatcher.contextTokens, accountId: d.dispatcher.accountId, statusText: dispatcher.statusText, busySince: dispatcher.busySince, spend: d.dispatcher.spend?.[month()] ?? null },
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
    // Inside the floating sidebar panel. Keep x in step with --lights-x in tokens.css.
    trafficLightPosition: mac ? { x: 22, y: 22 } : undefined,
    titleBarOverlay: mac ? undefined : { color: '#00000000', symbolColor: look.symbol, height: 44 },
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
  // macOS hides the traffic lights in full screen, so the page drops the room it keeps for them.
  const sendFullScreen = () => win?.webContents.send('fullscreen', win.isFullScreen());
  win.on('enter-full-screen', sendFullScreen);
  win.on('leave-full-screen', sendFullScreen);
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
  // A side question: its own session and thread, never the Dispatcher's (main/side.ts).
  handle('side:send', (text: string, model?: string | null, repo?: string | null) => side.send(text, model, repo));
  handle('side:stop', () => side.stop());
  handle('side:reset', () => side.reset());
  handle('side:state', () => side.state());
  // The side terminal (main/terminal.ts): its runs stay out of the chat and away from the Dispatcher.
  handle('term:run', (cmd: string, repo?: string | null) => terminal.run(String(cmd ?? ''), typeof repo === 'string' && repo ? repo : null));
  handle('term:stop', (id: string) => terminal.stop(String(id)));
  handle('term:clear', () => terminal.clear());
  handle('term:state', () => terminal.state());
  handle('chat:send', (text: string, files?: string[], replyTo?: string | null) => dispatcher.send(text, files ?? [], typeof replyTo === 'string' ? replyTo : null));
  handle('chat:stop', () => dispatcher.stop());
  // The quick message box: its texts, a send (the same as typing in the chat) and putting it away.
  handle('quick:text', () => ({ ph: t('quick.ph'), sent: t('quick.sent'), files: t('quick.files'), lang: loadSettings().language, theme: loadSettings().theme, fontFamily: loadSettings().fontFamily, fontSize: loadSettings().fontSize, repos: store.data.repos.map((r) => r.name) }));
  handle('quick:send', (text: string, files?: string[]) => dispatcher.send(String(text), Array.isArray(files) ? files.map(String) : []));
  handle('quick:close', () => closeQuick());
  handle('dispatcher:compact', () => dispatcher.compact());
  handle('dispatcher:clear', () => dispatcher.clear());
  // With ids, only those items; without, the whole list.
  handle('chat:clear', (kind: 'result' | 'auto', ids?: string[]) => {
    const only = Array.isArray(ids) ? new Set(ids.map(String)) : null;
    const hit = (id: string) => !only || only.has(id);
    if (kind === 'auto') store.data.autoAnswers.forEach((a) => { if (hit(a.id)) a.cleared = true; });
    else store.data.chat.forEach((c) => { if ((c.kind === 'result' || c.kind === 'error') && hit(c.id)) c.cleared = true; });
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
    workers.send(a.workerId, 'user', `[Correction] For "${a.question}" the Dispatcher answered "${a.answer}" on the user's behalf, but the user corrected it to "${newAnswer}". Adjust anything you already did accordingly.`)
      .catch((e) => store.chat('error', t('err.correction', { id: a.workerId, msg: (e as Error).message })));
    store.changed();
    suggestFromCorrection(a);
  });
  handle('suggest:save', (id: string, text?: string) => { const file = saveSuggestion(id, text); dispatcher.refreshContext(); return file; });
  handle('suggest:dismiss', (id: string) => dismissSuggestion(id));
  // A page of a Worker's conversation: the latest, or the one before line `before` (decision 85).
  handle('worker:log', (id: string, opts?: { before?: number; limit?: number }) => store.readLog(id, opts?.before, Math.min(opts?.limit ?? PAGE.log, 1000)));
  handle('search:text', (q: string) => store.searchText(String(q ?? '')));
  handle('chat:page', (before: string, limit?: number) => store.chatPage(before, Math.min(limit ?? PAGE.chat, 1000)));
  handle('worker:send', (id: string, text: string, files?: string[], answerId?: string | null) => {
    const body = text + attachmentBlock(registerAttachments(files ?? []));
    // It answers a decision only when the composer said so above the text (decision 93, M7); a permission never.
    const open = answerTarget(store.data.decisions, id, answerId);
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
  handle('mq:add', (taskIds: string[]) => queueMerge(Array.isArray(taskIds) ? taskIds.map(String) : []));
  handle('mq:remove', (taskId: string) => unqueueMerge(String(taskId)));
  handle('pr:refresh', () => checkPrsNow());
  handle('repo:issues', (name: string) => listIssues(name));
  handle('task:revoke', (taskId: string, key: string) => workers.revokeGrant(taskId, key));
  handle('preflight:run', async () => { const r = await runPreflight(); pushState(); return r; });
  handle('diag:export', () => exportDiagnostics(win));
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
  handle('auto:update', (id: string, prompt: string, trigger: AutoTrigger) => { automations.update(id, { prompt, trigger }); });
  handle('auto:toggle', (id: string, on: boolean) => automations.setEnabled(id, on));
  handle('auto:remove', (id: string) => { automations.remove(id); });
  // Refused while the Worker works; its dev server stops only once it may go.
  handle('worker:archive', (id: string) => { workers.checkArchive(id); runs.stop(id); return workers.archive(id); });
  handle('run:start', (id: string) => runs.start(id));
  handle('run:stop', (id: string) => runs.stop(id));
  handle('run:clear', (id: string) => runs.clear(id));
  handle('shell:run', (cmd: string, repo?: string | null) => shellRuns.run(String(cmd ?? ''), typeof repo === 'string' && repo ? repo : null, { ask: loadSettings().shellAsk }));
  handle('shell:stop', (id: string) => shellRuns.stop(id));
  // Saved scripts: only the Run button starts one, and it runs the stored command (main/scripts.ts).
  handle('script:add', (input: Partial<ScriptInput>) => addScript(input));
  handle('script:update', (id: string, input: Partial<ScriptInput>) => updateScript(id, input));
  handle('script:remove', (id: string) => removeScript(id));
  handle('script:run', (id: string) => runScript(id));
  handle('worker:unarchive', async (id: string) => { const w = store.worker(id); if (w) await workers.unarchive(w); });
  handle('repo:add', (url: string, name?: string, description?: string) => registerRepo({ url, name, description }).then((r) => { dispatcher.refreshContext(); return r; }));
  handle('repo:addCancel', () => cancelAddRepo());
  // Refused while one of its tasks is open; its Workers are archived and their worktrees removed first.
  handle('repo:remove', async (name: string) => {
    workers.checkRetire(name); // refused before anything is stopped
    for (const w of store.data.workers) if (w.repo === name) runs.stop(w.id);
    const kept = await workers.retireRepo(name);
    removeRepo(name);
    dispatcher.refreshContext();
    return kept;
  });
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
    store.handout(assignedEvent(task, worker, !!reused), task.id);
    return task.id;
  });
  handle('settings:save', (patch: Partial<SettingsView>) => {
    const before = loadSettings();
    // Compared with the folder in use: changing it and back again needs no restart.
    const homeChanged = !!patch.home && patch.home !== paths().home;
    const langChanged = (!!patch.language && patch.language !== before.language)
      || (patch.claudeRules !== undefined && patch.claudeRules !== before.claudeRules)
      || (patch.claudeMemory !== undefined && patch.claudeMemory !== before.claudeMemory)
      || (patch.claudeConnectors !== undefined && patch.claudeConnectors !== before.claudeConnectors)
      || (patch.artifactAutoReply !== undefined && patch.artifactAutoReply !== before.artifactAutoReply)
      || (!!patch.dispatcherEffort && patch.dispatcherEffort !== before.dispatcherEffort)
      || (!!patch.dispatcherModel && patch.dispatcherModel !== before.dispatcherModel)
      || (patch.effortPerTask !== undefined && patch.effortPerTask !== before.effortPerTask);
    const moreWorkers = patch.maxWorkers !== undefined && patch.maxWorkers > before.maxWorkers;
    const remoteChanged = patch.memoryRemote !== undefined && patch.memoryRemote.trim() !== before.memoryRemote.trim();
    const checkOn = patch.updateCheck === true && !before.updateCheck;
    const usageEvery = patch.usageRefreshMins !== undefined && patch.usageRefreshMins !== before.usageRefreshMins;
    updateSettings(patch);
    if (patch.updateCheck !== undefined) followUpdateSetting();
    if (checkOn) void checkUpdate();
    // The next round counts from now at the new interval (or there is none when it is only by hand).
    if (usageEvery) accounts.arm();
    const quickKeyOk = syncQuickKey(here);
    if (patch.theme !== undefined) applyTheme();
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
  // A round of reading usage now (Settings' account menu, the popover's button). Accounts the server asked to wait are skipped.
  handle('usage:refresh', () => accounts.refreshAll());
  handle('open:external', (url: string) => {
    if (fakeMode()) { e2eOpened.push(['open:external', url]); return; }
    if (/^https?:\/\//.test(url)) return shell.openExternal(url);
  });
  handle('open:path', async (p: string) => {
    if (fakeMode()) { e2eOpened.push(['open:path', p]); return; }
    // A path an agent reported may be a program or a script: those are shown in their folder, not run.
    let dir = false;
    try { dir = fs.statSync(p).isDirectory(); } catch { /* openPath says it is missing */ }
    if (!opensSafely(p, dir) && fs.existsSync(p)) { shell.showItemInFolder(p); return; }
    const err = await shell.openPath(p);
    if (err) throw new Error(err);
  });
  // A screenshot pasted into a composer is kept under the IDE home, so the agent can still read it later.
  handle('attach:pasteImage', (type: string, bytes: Uint8Array) => savePastedImage(path.join(paths().data, 'pasted'), type, bytes));
  handle('reveal:path', (p: string) => shell.showItemInFolder(p));
  handle('app:version', () => app.getVersion());
  // Settings > Models asks for a fresh list (at most a minute old), its Refresh button for a new one;
  // other callers take one up to 6 hours old.
  handle('models:list', (mode: 'cached' | 'fresh' | 'now') => listModels(mode === 'now' ? 0 : mode === 'fresh' ? 60_000 : 6 * 3600_000));
  handle('claude:info', (): ClaudeInfo => ({ home: claudeHome(), rules: ruleFiles(), memoryHome: path.join(claudeHome(), 'projects') }));
  handle('app:relaunch', () => { if (restartIntoUpdate(updateBlockers())) return; app.relaunch(); app.quit(); });
  // Restart into the downloaded update; refused (false) while a Worker, a queued task or the Dispatcher is working.
  handle('update:apply', () => applyUpdate(updateBlockers()));
}

async function boot() {
  loadSettings();
  ensureHome();
  log.info('boot', paths().home);
  // Before anything runs gh, git, codex or claude: an app opened from the macOS Dock lacks the shell's PATH.
  await fixToolPath();
  store.load();
  shellRuns.settle();
  // The state file was unreadable: say what was done about it, once, where the user will see it.
  if (store.restoredFrom) {
    log.error('state file unreadable; restored from', store.restoredFrom);
    store.chat('error', store.restoredFrom === 'none' ? t('backup.lost') : t('backup.restored', { day: store.restoredFrom }));
  }
  // The state is not written this launch (shared/migrate.ts): the user hears why before anything is lost.
  const ro = store.readOnly;
  if (ro) {
    log.error('state file opened read-only', JSON.stringify(ro));
    store.chat('error', ro.why === 'newer' ? t('state.newer', { version: ro.version }) : t('state.migrateFailed', { error: ro.error }));
  }
  if (store.migrated) log.info('state file migrated from version', store.migrated.from, 'copy kept at', store.migrated.copy);
  // One of the two files beside state.json held fewer records than state.json counted: what the backups gave back.
  for (const r of store.repaired) {
    log.error('state file lost records', JSON.stringify(r));
    store.chat('error', t(r.part === 'chat' ? 'state.chatDamaged' : 'state.tasksDamaged', { lost: r.restored + r.missing, restored: r.restored, missing: r.missing }));
  }
  if (store.skippedLines) log.warn('lines skipped in chat.jsonl and tasks-done.jsonl', store.skippedLines);
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
  repoEvents.on('progress', pushState);
  // Hooks for the end-to-end tests (test/e2e), which have no button for them; the window does not call them.
  if (fakeMode()) {
    handle('diag:text', () => diagnostics());
    handle('pr:check', () => checkPrs({ full: true }));
    // The half-minute checks run as if `ms` had passed: a slot given up after a long wait, a daily automation's time.
    handle('e2e:clock', (ms: number) => { const now = Date.now() + Number(ms); workers.sweepWaiting(now); automations.tick(new Date(now)); });
    // What a test run would have opened on the computer (open:path, open:external keep it instead).
    handle('e2e:opened', () => e2eOpened);
    handle('mq:run', () => runMergeQueue());
  }
  accounts.on('changed', pushState);
  accounts.on('changed', scheduleLimitRetry);
  store.on('workerLog', (id, item) => win?.webContents.send('workerLog', id, item));
  side.onChange((v) => win?.webContents.send('side-state', v));
  terminal.onChange((v) => win?.webContents.send('term-state', v));
  // Worker news worth a turn of its own: the Dispatcher starts one by itself.
  store.on('wake', () => dispatcher.wake());
  store.on('shell-done', () => dispatcher.shellDone());
  onDecisionCreated((d) => {
    // Simple decisions carry their answers as buttons on the notification.
    const actions = notifyActions(d).map((a) => ({ text: 'key' in a.label ? t(a.label.key) : a.label.text, run: () => answerByUser(d.id, a.answer) }));
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

/**
 * Screenshots a Worker reported, for the result card's thumbnails (T-0102): image files on this computer's own disks by
 * absolute path, nothing else (no network paths). Never cached, so a shot taken again under the same name shows anew.
 */
function serveShots() {
  protocol.handle(SHOT_SCHEME, async (req) => {
    const p = shotPath(req.url);
    if (!p || !path.isAbsolute(p)) return new Response(null, { status: 404 });
    try {
      const r = await net.fetch(pathToFileURL(p).toString());
      return new Response(r.body, { status: r.status, headers: { 'content-type': r.headers.get('content-type') ?? 'application/octet-stream', 'cache-control': 'no-store' } });
    } catch { return new Response(null, { status: 404 }); }
  });
}

/**
 * `--state-v1`: the saved state is written back as the one file an older build reads, and the app quits without
 * opening (decision 213). Only the one running instance does it, so nothing else writes the files meanwhile.
 */
function backToV1() {
  let said: string;
  let failed = false;
  try {
    const r = rollbackToV1(paths());
    log.info('state-v1', JSON.stringify(r));
    if (r.kind === 'done') said = t('state.v1Done', { tasks: r.tasks, chat: r.chat });
    else if (r.why === 'missing' || r.why === 'v1') said = t('state.v1Already');
    else {
      failed = true;
      said = t('state.v1Failed', { error: r.why === 'newer' ? `format ${r.version}` : 'state.json cannot be read' });
    }
  } catch (e) {
    log.error('state-v1 failed', e);
    failed = true;
    said = t('state.v1Failed', { error: e instanceof Error ? e.message : String(e) });
  }
  if (!fakeMode()) dialog.showMessageBoxSync({ type: failed ? 'error' : 'info', message: said });
  app.exit(failed ? 1 : 0);
}

installCrashHandlers();
protocol.registerSchemesAsPrivileged([{ scheme: SHOT_SCHEME, privileges: { standard: true, secure: true } }]);
const single = app.requestSingleInstanceLock();
if (!single) app.quit();
else if (process.argv.includes(V1_ARG)) void app.whenReady().then(backToV1);
else {
  // A second launch shows the window; with --quick it opens the quick message box instead (for a launcher or a pinned shortcut).
  app.on('second-instance', (_e, argv) => { if (argv.includes(QUICK_ARG)) openQuick(here); else showWindow(win); });
  app.whenReady().then(async () => {
    registerIpc();
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
    store.flush();
    saveSettings();
  });
}
