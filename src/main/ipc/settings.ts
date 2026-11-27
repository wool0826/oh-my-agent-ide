import path from 'node:path';
import { ASSIGN_MODES, type AssignMode } from '../../shared/accountPause';
import { clipboard, dialog } from 'electron';
import { handle, type IpcContext } from './handle';
import { loadSettings, updateSettings } from '../settings';
import { paths } from '../paths';
import { accounts } from '../accounts';
import { syncMemory } from '../memory';
import { dispatcher } from '../agents/dispatcher';
import { workers } from '../agents/workers';
import { soundData, SOUND_EXTS } from '../notify';
import { claudeHome, ruleFiles } from '../claudeContext';
import { listModels } from '../models';
import { checkUpdate, followUpdateSetting } from '../update';
import { syncQuickKey } from '../quick';
import { runPreflight } from '../preflight';
import { exportDiagnostics } from '../diagnostics';
import type { AccountPlan, ClaudeInfo, SettingsView } from '../../shared/types';

/** Settings, accounts, models, the checks of this computer and the diagnostics report. */
export function registerSettingsIpc(ctx: IpcContext) {
  handle('preflight:run', async () => { const r = await runPreflight(); ctx.pushState(); return r; });
  handle('diag:export', () => exportDiagnostics(ctx.win()));
  // The main process's clipboard: it takes text without the window being focused, unlike navigator.clipboard.
  handle('clipboard:write', async (text: string) => { await clipboard.writeText(String(text)); });
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
    const quickKeyOk = syncQuickKey(ctx.here);
    if (patch.theme !== undefined) ctx.applyTheme();
    ctx.syncTray();
    ctx.syncLoginItem();
    ctx.syncAwake();
    if (langChanged) dispatcher.refreshContext();
    // A new address is tried at once, so a wrong one shows its error here and not at the next memory write.
    if (remoteChanged) void syncMemory();
    // A higher limit starts tasks waiting for a slot now; a lower one stops nothing that runs.
    if (moreWorkers) workers.fillSlots();
    ctx.pushState(); // apply changed settings (language, font) right away
    return { restart: homeChanged, quickKeyOk };
  });
  handle('settings:pickHome', async () => {
    const r = await dialog.showOpenDialog(ctx.win()!, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('sound:pick', async () => {
    const r = await dialog.showOpenDialog(ctx.win()!, { properties: ['openFile'], filters: [{ name: 'Audio', extensions: SOUND_EXTS }] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('sound:data', (file: string) => soundData(file));
  handle('account:add', (label: string, kind: 'token' | 'login', token: string, plan?: AccountPlan) => accounts.add(label, kind, token, plan));
  handle('account:addChatgpt', async (label: string) => { const id = await accounts.addChatgpt(label); void listModels(0).then(ctx.pushState); return id; });
  handle('account:remove', (id: string) => accounts.remove(id));
  handle('account:rename', (id: string, label: string) => accounts.rename(id, label));
  handle('account:plan', (id: string, plan: AccountPlan) => accounts.setPlan(id, plan));
  // A value that is not a choice of the switch changes nothing (it must not switch an account back on).
  handle('account:assign', (id: string, mode: string) => { if (ASSIGN_MODES.includes(mode as AssignMode)) accounts.setAssign(id, mode as AssignMode); });
  handle('account:resumeAll', () => accounts.resumeAll());
  // A round of reading usage now (Settings' account menu, the popover's button). Accounts the server asked to wait are skipped.
  handle('usage:refresh', () => accounts.refreshAll());
  // Settings > Models asks for a fresh list (at most a minute old), its Refresh button for a new one;
  // other callers take one up to 6 hours old.
  handle('models:list', (mode: 'cached' | 'fresh' | 'now') => listModels(mode === 'now' ? 0 : mode === 'fresh' ? 60_000 : 6 * 3600_000));
  handle('claude:info', (): ClaudeInfo => ({ home: claudeHome(), rules: ruleFiles(), memoryHome: path.join(claudeHome(), 'projects') }));
}
