import fs from 'node:fs';
import path from 'node:path';
import { loadSettings, decryptToken, dataDir } from './settings';
import { claudeHome } from './claudeContext';
import { readJson, writeJsonAtomic } from './util';
import { log } from './log';
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

export function cachedModels(): ModelList {
  cache ??= readJson<ModelList>(file(), { models: [], fetchedAt: null, error: null });
  return cache;
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
export function listModels(maxAgeMs: number): Promise<ModelList> {
  const c = cachedModels();
  if (c.models.length && c.fetchedAt && Date.now() - Date.parse(c.fetchedAt) < maxAgeMs) return Promise.resolve(c);
  inflight ??= (async () => {
    // no-account: nothing registered; no-token: accounts, but no token this app can read.
    let error = loadSettings().accounts.length ? 'no-token' : 'no-account';
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
    cache = { ...cachedModels(), error };
    return cache;
  })().finally(() => { inflight = null; });
  return inflight;
}
