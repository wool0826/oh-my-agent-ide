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
import { startPrMonitor, checkPrs } from './prmonitor';
import { notifyDecision, setWindow } from './notify';
import { log } from './log';
import { nowIso, oneLine } from './util';
import type { AppState, SettingsView } from '../shared/types';

const here = path.dirname(fileURLToPath(import.meta.url));
let win: BrowserWindow | null = null;

// 테스트나 두 번째 프로필용: 설정과 데이터를 다른 폴더에 둔다.
if (process.env.OMA_DATA_DIR) app.setPath('userData', path.resolve(process.env.OMA_DATA_DIR));

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
    },
  });
  setWindow(win);
  win.loadFile(path.join(here, 'renderer', 'index.html'));
  win.on('focus', () => win?.flashFrame(false));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:')) {
      e.preventDefault();
      if (/^https?:/.test(url)) void shell.openExternal(url);
    }
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
  handle('chat:send', (text: string) => dispatcher.send(text));
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
    const who = d.workerId ? `${d.workerId}의 ` : '';
    store.chat('decision', `${who}${oneLine(d.title, 80)} → ${ans}`);
    if (d.source === 'dispatcher') dispatcher.decisionAnswered(d.title, ans);
    remember('decision', `${d.workerId ?? 'Dispatcher'}: ${oneLine(d.title, 160)} → ${ans}`);
  });
  handle('auto:correct', (id: string, newAnswer: string, scope: 'once' | 'preference') => {
    const a = store.data.autoAnswers.find((x) => x.id === id);
    if (!a) throw new Error('없는 항목이에요.');
    a.corrected = { answer: newAnswer, scope, at: nowIso() };
    store.chat('event', `대신 답한 것을 정정했어요: "${oneLine(a.question, 60)}" → ${newAnswer}${scope === 'preference' ? ' (선호도 고침)' : ''}`);
    if (scope === 'preference') revisePreference(a.basis, `${oneLine(a.question, 120)} → ${newAnswer}`);
    try {
      workers.send(a.workerId, 'user', `[정정] 앞서 "${a.question}" 질문에 Dispatcher가 "${a.answer}"라고 대신 답했지만, 사용자가 "${newAnswer}"로 정정했습니다. 이미 진행한 부분이 있으면 맞게 고쳐 주세요.`);
    } catch (e) {
      store.chat('error', `${a.workerId}에게 정정을 전하지 못했어요: ${(e as Error).message}`);
    }
    store.changed();
  });
  handle('worker:log', (id: string) => store.readLog(id));
  handle('worker:send', (id: string, text: string) => workers.send(id, 'user', text));
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
    if (!repo) throw new Error(`등록되지 않은 저장소예요: ${repoName}`);
    const notes = readMemory(`repos/${repo.name}.md`);
    const owner = store.data.workers
      .filter((w) => w.repo === repo.name && w.status !== 'archived')
      .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))[0];
    const { task, worker } = await createTask({
      title: `${repo.name} CLAUDE.md에 IDE 메모리 반영`,
      kind: 'code',
      repo: repo.name,
      worker_id: owner?.id,
      prompt: [
        `아래는 IDE 메모리에 쌓인 ${repo.name} 저장소 메모입니다. 이 중 저장소에서 일하는 누구에게나 도움이 되는 규칙과 관례만 골라 저장소의 CLAUDE.md에 반영하는 PR을 만들어 주세요.`,
        '개인 선호나 일회성 기록, 이미 CLAUDE.md에 있는 내용은 빼고, 기존 CLAUDE.md의 구성과 말투를 따르세요. CLAUDE.md가 없으면 새로 만듭니다.',
        '',
        notes,
      ].join('\n'),
    });
    store.chat('event', `${worker.id}에게 "${task.title}"을 맡겼어요`);
    return task.id;
  });
  handle('settings:save', (patch: Partial<SettingsView>) => {
    const homeChanged = patch.home && patch.home !== loadSettings().home;
    updateSettings(patch);
    pushState(); // 바뀐 설정(글꼴 등)을 화면에 바로 반영
    if (homeChanged) return { restart: true };
    return { restart: false };
  });
  handle('settings:pickHome', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('account:add', (label: string, kind: 'token' | 'login', token: string) => accounts.add(label, kind, token));
  handle('account:remove', (id: string) => accounts.remove(id));
  handle('account:rename', (id: string, label: string) => accounts.rename(id, label));
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
  // 지난 실행에서 Worker가 기다리던 질문과 권한 요청은 Worker가 이어서 진행하며 다시 묻는다.
  for (const d of [...store.data.decisions]) if (d.status === 'pending' && d.source !== 'dispatcher') withdraw(d.id);
  await initMemory();
  installPlugin();
  store.on('changed', pushState);
  accounts.on('changed', pushState);
  store.on('workerLog', (id, item) => win?.webContents.send('workerLog', id, item));
  onDecisionCreated((d) => {
    notifyDecision(d.workerId ? `${d.workerId}가 결정을 기다려요` : '결정이 필요해요', d.title);
  });
  onLateAnswer((d) => {
    if (d.workerId) {
      try { workers.send(d.workerId, 'user', `[사용자 답변] 질문: ${d.title}\n답: ${d.answer}`); } catch (e) { log.warn('late answer', e); }
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
      dialog.showErrorBox('Oh My Agent IDE를 시작하지 못했어요', String((e as Error).message));
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
