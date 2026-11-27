import { app, safeStorage } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { readJson, writeJsonAtomic, uid } from './util';
import type { AccountPlan, Provider, SettingsView, UsageWindow } from '../shared/types';
import { cleanAskOff } from '../shared/grants';
import { cleanTheme } from '../shared/theme';
import { cleanTime, notifyDoneFrom } from '../shared/notifyRules';
import { DONE_SOUND_DEFAULT, cleanDoneSound } from '../shared/sounds';
import { QUICK_KEY_DEFAULT, normalizeQuickKey } from '../shared/quickKey';
import { FONT_SIZE_DEFAULT, clampFontSize, normalizeFontFamily } from '../shared/font';
import { MAX_WORKERS_DEFAULT, WAIT_SLOT_DEFAULT, clampMaxWorkers, clampWaitSlot } from '../shared/slots';
import { USAGE_INTERVAL_DEFAULT, clampUsageMins } from '../shared/usage';

export interface StoredAccount {
  id: string;
  label: string;
  kind: 'token' | 'login';
  plan: AccountPlan;
  /** claude, or chatgpt: this PC's Codex sign-in (always kind login; the app holds no token for it). */
  provider: Provider;
  planLabel?: string | null;
  windowMins?: [number | null, number | null] | null;
  /** Token encrypted with safeStorage (base64). Empty for login accounts. */
  tokenEnc: string;
  fiveHour: UsageWindow;
  sevenDay: UsageWindow;
  usageUpdatedAt: string | null;
  usageSource: 'endpoint' | 'probe' | 'events' | null;
  limitedUntil: string | null;
  lastAssignedAt: string | null;
  lastError: string | null;
  /** The usage endpoint rate-limited us (429); don't ask again before this time. */
  usageBackoffUntil?: string | null;
  /** The usage endpoint refused this token (an inference-only setup token): read usage from a one-token request instead. */
  usageProbe?: boolean;
}

export interface Settings extends SettingsView {
  accounts: StoredAccount[];
  /** The Jira API token, encrypted like an account token. */
  jiraTokenEnc?: string;
  /** The Telegram bot token, encrypted with safeStorage only (src/main/remote/telegramLink.ts). */
  telegramTokenEnc?: string;
  /** The bot and its owner (shared/remote.ts TelegramStored); the page gets AppState.telegram instead. */
  telegram?: unknown;
}

export const dataDir = () => (process.env.OMA_DATA_DIR ? path.resolve(process.env.OMA_DATA_DIR) : app.getPath('userData'));
const file = () => path.join(dataDir(), 'settings.json');

export const DEFAULTS: SettingsView = {
  language: 'en',
  home: path.join(os.homedir(), 'oh-my-agent-ide'),
  githubHost: '',
  notifications: true,
  notifyDone: true,
  quietFrom: '',
  quietTo: '',
  sound: 'chime',
  doneSound: DONE_SOUND_DEFAULT,
  soundVolume: 70,
  customSound: '',
  archiveDays: 7,
  memoryRemote: '',
  dispatcherModel: 'claude-sonnet-5-5',
  workerModel: 'claude-opus-5-5',
  designModel: 'claude-fable-5-2',
  dispatcherEffort: 'medium',
  workerEffort: 'high',
  effortPerTask: true,
  selfReview: true,
  maxWorkers: MAX_WORKERS_DEFAULT,
  waitSlotMinutes: WAIT_SLOT_DEFAULT,
  usageRefreshMins: USAGE_INTERVAL_DEFAULT,
  askOff: [],
  updateCheck: true,
  quickKey: QUICK_KEY_DEFAULT,
  jiraUrl: '',
  jiraEmail: '',
  jiraTokenSet: false,
  fontFamily: '',
  fontSize: FONT_SIZE_DEFAULT,
  theme: 'dark',
  claudeRules: true,
  claudeMemory: true,
  claudeConnectors: true,
  artifactAutoReply: true,
  memorySuggest: true,
  shellAsk: true,
  shellProfile: true,
  background: true,
  openAtLogin: false,
  keepAwake: true,
};

/**
 * The model for the small Claude Code helpers (the answer-for-you check, the memory suggestion, the reviewer
 * subagent): the Dispatcher's model, unless that is a ChatGPT model, which Claude Code cannot run.
 */
export function claudeHelperModel(): string {
  const s = loadSettings();
  const isClaude = (m: string) => /^claude/i.test(m);
  return [s.dispatcherModel, s.workerModel].find(isClaude) ?? DEFAULTS.dispatcherModel;
}

let cache: Settings | null = null;

export function loadSettings(): Settings {
  if (cache) return cache;
  const raw = readJson<Partial<Settings>>(file(), {});
  cache = { ...DEFAULTS, ...raw, accounts: (raw.accounts ?? []).map(fixAccount) };
  // Task-end notifications got a switch of their own; the old one they shared with decisions is dropped.
  cache.notifyDone = notifyDoneFrom(raw);
  delete (cache as { notifyResults?: boolean }).notifyResults;
  fix(cache);
  return cache;
}

/** Clean values so a hand-edited settings.json or bad input never breaks the UI or the Worker limit. */
function fix(s: SettingsView) {
  s.fontFamily = normalizeFontFamily(s.fontFamily);
  s.fontSize = clampFontSize(s.fontSize);
  s.maxWorkers = clampMaxWorkers(s.maxWorkers);
  s.waitSlotMinutes = clampWaitSlot(s.waitSlotMinutes);
  s.usageRefreshMins = clampUsageMins(s.usageRefreshMins);
  s.askOff = cleanAskOff(s.askOff);
  s.theme = cleanTheme(s.theme);
  s.quietFrom = cleanTime(s.quietFrom);
  s.quietTo = cleanTime(s.quietTo);
  s.doneSound = cleanDoneSound(s.doneSound);
  s.quickKey = normalizeQuickKey(String(s.quickKey ?? '')) ?? QUICK_KEY_DEFAULT;
}

function fixAccount(a: Partial<StoredAccount>): StoredAccount {
  return {
    id: a.id ?? uid(),
    label: a.label ?? 'Account',
    kind: a.kind ?? 'token',
    plan: a.plan ?? 'team',
    provider: a.provider ?? 'claude',
    planLabel: a.planLabel ?? null,
    windowMins: a.windowMins ?? null,
    tokenEnc: a.tokenEnc ?? '',
    fiveHour: a.fiveHour ?? { utilization: null, resetsAt: null },
    sevenDay: a.sevenDay ?? { utilization: null, resetsAt: null },
    usageUpdatedAt: a.usageUpdatedAt ?? null,
    usageSource: a.usageSource ?? null,
    limitedUntil: a.limitedUntil ?? null,
    lastAssignedAt: a.lastAssignedAt ?? null,
    lastError: a.lastError ?? null,
    usageBackoffUntil: a.usageBackoffUntil ?? null,
    usageProbe: a.usageProbe ?? false,
  };
}

export function saveSettings() {
  if (cache) writeJsonAtomic(file(), cache);
}

export function updateSettings(patch: Partial<SettingsView>) {
  const s = loadSettings();
  // A patch from the window never replaces what only the main process writes: accounts and stored tokens.
  const { accounts: _a, jiraTokenEnc: _j, telegramTokenEnc: _t, telegram: _g, ...safe } = patch as Partial<Settings>;
  Object.assign(s, safe);
  fix(s);
  saveSettings();
}

export function encryptToken(token: string): string {
  if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(token).toString('base64');
  // Where encryption is unavailable (some Linux setups), at least mark it as raw.
  return 'raw:' + Buffer.from(token, 'utf8').toString('base64');
}

export function decryptToken(enc: string): string {
  if (!enc) return '';
  if (enc.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(enc.slice(4), 'base64'));
  if (enc.startsWith('raw:')) return Buffer.from(enc.slice(4), 'base64').toString('utf8');
  return '';
}

export function settingsView(): SettingsView {
  const { accounts: _a, jiraTokenEnc, telegramTokenEnc: _t, telegram: _g, ...rest } = loadSettings();
  return { ...rest, jiraTokenSet: !!jiraTokenEnc };
}

/** Stores the Jira token encrypted; an empty one removes it. */
export function updateJiraToken(token: string) {
  const s = loadSettings();
  s.jiraTokenEnc = token ? encryptToken(token) : '';
  saveSettings();
}

export function jiraToken(): string {
  const enc = loadSettings().jiraTokenEnc;
  return enc ? decryptToken(enc) : '';
}
