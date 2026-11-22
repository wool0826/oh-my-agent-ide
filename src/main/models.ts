import fs from 'node:fs';
import path from 'node:path';
import { loadSettings, decryptToken, dataDir } from './settings';
import { claudeHome } from './claudeContext';
import { readJson, writeJsonAtomic } from './util';
import { log } from './log';
import { codexClient } from './codex/client';
import { modelLabel, sortModels } from '../shared/models';
import type { ModelInfo, ModelList } from '../shared/types';

/**
 * The models an account can use, read from the API's model list so new models show up without an
 * app update. Kept in models.json; refreshed when older than the caller allows.
 */
const MODELS_URL = 'https://api.anthropic.com/v1/models';
const file = () => path.join(dataDir(), 'models.json');

let cache: ModelList | null = null;
let inflight: Promise<ModelList> | null = null;

/**
 * When no token can read the API list (macOS keeps the Claude Code login in the Keychain; a login token
 * may have expired), a running agent session can still say which models Claude Code offers.
 */
let sessionSource: () => Promise<{ id: string; name: string }[] | null> = async () => null;
export function setSessionModelSource(fn: typeof sessionSource) { sessionSource = fn; }

/** Claude's models as last read, without the ChatGPT ones. */
function claudeCache(): ModelList {
  cache ??= readJson<ModelList>(file(), { models: [], fetchedAt: null, error: null });
  return cache;
}

/** The models Codex offers the ChatGPT account, kept apart: they come from Codex, not from the Anthropic API. */
const codexFile = () => path.join(dataDir(), 'codex-models.json');
let codexCache: { models: ModelInfo[]; fetchedAt: string | null } | null = null;
function codexModels() {
  codexCache ??= readJson<{ models: ModelInfo[]; fetchedAt: string | null }>(codexFile(), { models: [], fetchedAt: null });
  return codexCache;
}
const hasChatgpt = () => loadSettings().accounts.some((a) => a.provider === 'chatgpt');

async function refreshCodexModels(maxAgeMs: number) {
  if (!hasChatgpt()) return;
  const c = codexModels();
  if (c.models.length && c.fetchedAt && Date.now() - Date.parse(c.fetchedAt) < maxAgeMs) return;
  try {
    const r = await codexClient().request<{ data: { model: string; displayName?: string; hidden?: boolean }[] }>('model/list', {}, 30_000);
    const models = (r?.data ?? []).filter((m) => m?.model && !m.hidden).map((m) => ({ id: m.model, name: String(m.displayName || m.model), created: '', provider: 'chatgpt' as const }));
    if (!models.length) return;
    codexCache = { models, fetchedAt: new Date().toISOString() };
    writeJsonAtomic(codexFile(), codexCache);
  } catch (e) {
    log.warn('codex model list', (e as Error).message);
  }
}

/** Every model a registered account can run: Claude's, then the ChatGPT account's while one is registered. */
function merged(c: ModelList): ModelList {
  const extra = hasChatgpt() ? codexModels().models : [];
  if (!extra.length) return c;
  // With no Claude account, the Claude list's "no token" is not an error worth showing: the ChatGPT models are there.
  return { models: [...c.models, ...extra], fetchedAt: c.fetchedAt ?? codexModels().fetchedAt, error: c.models.length ? c.error : null };
}

export function cachedModels(): ModelList {
  return merged(claudeCache());
}

/** This PC's Claude Code login token. Claude Code refreshes it while it runs, so it can be expired. */
function loginToken(): string {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(claudeHome(), '.credentials.json'), 'utf8'));
    return typeof j?.claudeAiOauth?.accessToken === 'string' ? j.claudeAiOauth.accessToken : '';
  } catch {
    return '';
  }
}

/** One token per registered account, in the order they were added. */
function tokens(): string[] {
  const out: string[] = [];
  for (const a of loadSettings().accounts) {
    if (a.provider !== 'claude') continue;
    const tok = a.kind === 'token' ? decryptToken(a.tokenEnc) : loginToken();
    if (tok && !out.includes(tok)) out.push(tok);
  }
  return out;
}

async function fetchModels(token: string): Promise<ModelInfo[]> {
  const out: ModelInfo[] = [];
  let after = '';
  for (let page = 0; page < 10; page++) {
    const res = await fetch(`${MODELS_URL}?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ''}`, {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j: any = await res.json();
    for (const m of j?.data ?? []) {
      if (typeof m?.id === 'string') out.push({ id: m.id, name: String(m.display_name || m.id), created: String(m.created_at ?? '') });
    }
    if (!j?.has_more || !j?.last_id) break;
    after = j.last_id;
  }
  return out;
}

/** The model list, read again when the saved one is older than maxAgeMs. On failure the last list stays. */
export async function listModels(maxAgeMs: number): Promise<ModelList> {
  const [claude] = await Promise.all([listClaudeModels(maxAgeMs), refreshCodexModels(maxAgeMs)]);
  return merged(claude);
}

function listClaudeModels(maxAgeMs: number): Promise<ModelList> {
  const c = claudeCache();
  if (c.models.length && c.fetchedAt && Date.now() - Date.parse(c.fetchedAt) < maxAgeMs) return Promise.resolve(c);
  inflight ??= (async () => {
    // no-account: nothing registered; no-token: accounts, but no token this app can read.
    const claudeAccounts = loadSettings().accounts.filter((a) => a.provider === 'claude');
    let error = claudeAccounts.length ? 'no-token' : 'no-account';
    for (const token of tokens()) {
      try {
        const models = await fetchModels(token);
        if (!models.length) { error = 'empty'; continue; }
        cache = { models: sortModels(models), fetchedAt: new Date().toISOString(), error: null };
        writeJsonAtomic(file(), cache);
        return cache;
      } catch (e) {
        error = (e as Error).message;
        log.warn('model list', error);
      }
    }
    const fromSession = await sessionSource().catch(() => null);
    const ids = new Set<string>();
    const models = (fromSession ?? []).filter((m) => /^claude-/.test(m.id) && !ids.has(m.id) && ids.add(m.id)).map((m) => ({ id: m.id, name: modelLabel(m.id), created: '' }));
    if (models.length) {
      cache = { models, fetchedAt: new Date().toISOString(), error: null };
      writeJsonAtomic(file(), cache);
      return cache;
    }
    cache = { ...claudeCache(), error };
    return cache;
  })().finally(() => { inflight = null; });
  return inflight;
}
