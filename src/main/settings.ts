import { app, safeStorage } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { readJson, writeJsonAtomic, uid } from './util';
import type { AccountPlan, SettingsView, UsageWindow } from '../shared/types';
import { FONT_SIZE_DEFAULT, clampFontSize, normalizeFontFamily } from '../shared/font';

export interface StoredAccount {
  id: string;
  label: string;
  kind: 'token' | 'login';
  plan: AccountPlan;
  /** Token encrypted with safeStorage (base64). Empty for login accounts. */
  tokenEnc: string;
  fiveHour: UsageWindow;
  sevenDay: UsageWindow;
  usageUpdatedAt: string | null;
  usageSource: 'endpoint' | 'events' | null;
  limitedUntil: string | null;
  lastAssignedAt: string | null;
  lastError: string | null;
  /** The usage endpoint rate-limited us (429); don't ask again before this time. */
  usageBackoffUntil?: string | null;
}

export interface Settings extends SettingsView {
  accounts: StoredAccount[];
}

export const dataDir = () => (process.env.OMA_DATA_DIR ? path.resolve(process.env.OMA_DATA_DIR) : app.getPath('userData'));
const file = () => path.join(dataDir(), 'settings.json');

export const DEFAULTS: SettingsView = {
  language: 'en',
  home: path.join(os.homedir(), 'oh-my-agent-ide'),
  githubHost: '',
  notifications: true,
  sound: 'chime',
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
  fontFamily: '',
  fontSize: FONT_SIZE_DEFAULT,
  claudeRules: true,
  claudeMemory: true,
  memorySuggest: true,
};

let cache: Settings | null = null;

export function loadSettings(): Settings {
  if (cache) return cache;
  const raw = readJson<Partial<Settings>>(file(), {});
  cache = { ...DEFAULTS, ...raw, accounts: (raw.accounts ?? []).map(fixAccount) };
  fixFont(cache);
  return cache;
}

/** Clean font values so a hand-edited settings.json or bad input never breaks the UI. */
function fixFont(s: SettingsView) {
  s.fontFamily = normalizeFontFamily(s.fontFamily);
  s.fontSize = clampFontSize(s.fontSize);
}

function fixAccount(a: Partial<StoredAccount>): StoredAccount {
  return {
    id: a.id ?? uid(),
    label: a.label ?? 'Account',
    kind: a.kind ?? 'token',
    plan: a.plan ?? 'team',
    tokenEnc: a.tokenEnc ?? '',
    fiveHour: a.fiveHour ?? { utilization: null, resetsAt: null },
    sevenDay: a.sevenDay ?? { utilization: null, resetsAt: null },
    usageUpdatedAt: a.usageUpdatedAt ?? null,
    usageSource: a.usageSource ?? null,
    limitedUntil: a.limitedUntil ?? null,
    lastAssignedAt: a.lastAssignedAt ?? null,
    lastError: a.lastError ?? null,
    usageBackoffUntil: a.usageBackoffUntil ?? null,
  };
}

export function saveSettings() {
  if (cache) writeJsonAtomic(file(), cache);
}

export function updateSettings(patch: Partial<SettingsView>) {
  const s = loadSettings();
  Object.assign(s, patch);
  fixFont(s);
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
  const { accounts: _a, ...rest } = loadSettings();
  return rest;
}
