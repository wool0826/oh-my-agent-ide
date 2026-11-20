import { app, safeStorage } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { readJson, writeJsonAtomic, uid } from './util';
import type { SettingsView, UsageWindow } from '../shared/types';
import { FONT_SIZE_DEFAULT, clampFontSize, normalizeFontFamily } from '../shared/font';

export interface StoredAccount {
  id: string;
  label: string;
  kind: 'token' | 'login';
  /** safeStorage로 암호화한 토큰(base64). login 계정은 비어 있음 */
  tokenEnc: string;
  fiveHour: UsageWindow;
  sevenDay: UsageWindow;
  usageUpdatedAt: string | null;
  usageSource: 'endpoint' | 'events' | null;
  limitedUntil: string | null;
  lastAssignedAt: string | null;
  lastError: string | null;
}

export interface Settings extends SettingsView {
  accounts: StoredAccount[];
}

const dataDir = () => (process.env.OMA_DATA_DIR ? path.resolve(process.env.OMA_DATA_DIR) : app.getPath('userData'));
const file = () => path.join(dataDir(), 'settings.json');

export const DEFAULTS: SettingsView = {
  home: path.join(os.homedir(), 'OhMyAgentIDE'),
  githubHost: '',
  notifications: true,
  archiveDays: 7,
  memoryRemote: '',
  dispatcherModel: 'claude-sonnet-5-5',
  workerModel: 'claude-opus-5-5',
  designModel: 'claude-fable-5-2',
  fontFamily: '',
  fontSize: FONT_SIZE_DEFAULT,
};

let cache: Settings | null = null;

export function loadSettings(): Settings {
  if (cache) return cache;
  const raw = readJson<Partial<Settings>>(file(), {});
  cache = { ...DEFAULTS, ...raw, accounts: (raw.accounts ?? []).map(fixAccount) };
  fixFont(cache);
  return cache;
}

/** 손으로 고친 settings.json이나 잘못된 입력이 와도 화면이 깨지지 않게 글꼴 값을 정리한다. */
function fixFont(s: SettingsView) {
  s.fontFamily = normalizeFontFamily(s.fontFamily);
  s.fontSize = clampFontSize(s.fontSize);
}

function fixAccount(a: Partial<StoredAccount>): StoredAccount {
  return {
    id: a.id ?? uid(),
    label: a.label ?? '계정',
    kind: a.kind ?? 'token',
    tokenEnc: a.tokenEnc ?? '',
    fiveHour: a.fiveHour ?? { utilization: null, resetsAt: null },
    sevenDay: a.sevenDay ?? { utilization: null, resetsAt: null },
    usageUpdatedAt: a.usageUpdatedAt ?? null,
    usageSource: a.usageSource ?? null,
    limitedUntil: a.limitedUntil ?? null,
    lastAssignedAt: a.lastAssignedAt ?? null,
    lastError: a.lastError ?? null,
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
  // 암호화를 못 쓰는 환경(일부 Linux)에서는 평문 대신 표시만 해 둔다.
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
