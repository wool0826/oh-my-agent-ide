import { EventEmitter } from 'node:events';
import { loadSettings, saveSettings, encryptToken, decryptToken, type StoredAccount } from './settings';
import { log } from './log';
import { nowIso, uid } from './util';
import { t } from './i18n';
import { MAX_ACCOUNTS, type AccountPlan, type AccountView, type UsageWindow } from '../shared/types';

/** Above this usage (%) an account gets no new sessions, and running work moves to another account. */
export const RED = 80;

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

class Accounts extends EventEmitter {
  list(): StoredAccount[] {
    return loadSettings().accounts;
  }

  get(id: string | null) {
    return this.list().find((a) => a.id === id) ?? null;
  }

  views(): AccountView[] {
    return this.list().map((a) => ({
      id: a.id, label: a.label, kind: a.kind, plan: a.plan,
      fiveHour: a.fiveHour, sevenDay: a.sevenDay,
      usageUpdatedAt: a.usageUpdatedAt, usageSource: a.usageSource,
      limited: this.isLimited(a), lastError: a.lastError,
    }));
  }

  add(label: string, kind: 'token' | 'login', token: string, plan: AccountPlan = 'team') {
    const s = loadSettings();
    if (s.accounts.length >= MAX_ACCOUNTS) throw new Error(t('acc.err.max', { n: MAX_ACCOUNTS }));
    if (kind === 'login' && s.accounts.some((a) => a.kind === 'login')) throw new Error(t('acc.err.oneLogin'));
    const tok = token.trim();
    if (kind === 'token' && !/^sk-ant-/.test(tok)) throw new Error(t('acc.err.token'));
    const acc: StoredAccount = {
      id: uid(), label: label.trim() || t('acc.defaultName', { n: s.accounts.length + 1 }), kind, plan,
      tokenEnc: kind === 'token' ? encryptToken(tok) : '',
      fiveHour: { utilization: null, resetsAt: null }, sevenDay: { utilization: null, resetsAt: null },
      usageUpdatedAt: null, usageSource: null, limitedUntil: null, lastAssignedAt: null, lastError: null, usageBackoffUntil: null,
    };
    s.accounts.push(acc);
    saveSettings();
    this.emit('changed');
    void this.refresh(acc.id);
    return acc.id;
  }

  remove(id: string) {
    const s = loadSettings();
    s.accounts = s.accounts.filter((a) => a.id !== id);
    saveSettings();
    this.emit('changed');
  }

  rename(id: string, label: string) {
    const a = this.get(id);
    if (!a) return;
    a.label = label.trim() || a.label;
    saveSettings();
    this.emit('changed');
  }

  setPlan(id: string, plan: AccountPlan) {
    const a = this.get(id);
    if (!a) return;
    a.plan = plan;
    saveSettings();
    this.emit('changed');
  }

  /** Environment for a Claude Code process. Login accounts use the existing login as is. */
  env(id: string | null): NodeJS.ProcessEnv {
    // Launched from a Claude Code terminal, that session's variables leak in. Strip them so child sessions don't think they are nested.
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k === 'CLAUDE_CONFIG_DIR' || k === 'ANTHROPIC_BASE_URL') { env[k] = v; continue; }
      if (/^(CLAUDECODE|CLAUDE_|AI_AGENT$|MCP_CONNECTION|MCP_SERVER_CONNECTION|BAGGAGE$|ANTHROPIC_API_KEY$|ANTHROPIC_AUTH_TOKEN$)/.test(k)) continue;
      env[k] = v;
    }
    env.CLAUDE_AGENT_SDK_CLIENT_APP = 'oh-my-agent-ide/0.2.0';
    const a = this.get(id);
    if (a?.kind === 'token') env.CLAUDE_CODE_OAUTH_TOKEN = decryptToken(a.tokenEnc);
    return env;
  }

  private score(a: StoredAccount) {
    return Math.max(a.fiveHour.utilization ?? 0, a.sevenDay.utilization ?? 0);
  }

  isLimited(a: StoredAccount) {
    if (a.limitedUntil && Date.parse(a.limitedUntil) > Date.now()) return true;
    return this.score(a) > RED;
  }

  /**
   * Pick an account for a new session: the lowest usage among accounts that are not limited;
   * within 5 points, the one assigned longest ago. `exclude` is the account that just hit its limit.
   */
  pick(exclude?: string | null): StoredAccount | null {
    const all = this.list().filter((a) => a.id !== exclude);
    if (!all.length) return null;
    const open = all.filter((a) => !this.isLimited(a));
    const pool = open.length ? open : [];
    if (!pool.length) return null;
    pool.sort((x, y) => {
      const d = this.score(x) - this.score(y);
      if (Math.abs(d) > 5) return d;
      return Date.parse(x.lastAssignedAt ?? '1970-01-01') - Date.parse(y.lastAssignedAt ?? '1970-01-01');
    });
    const chosen = pool[0];
    chosen.lastAssignedAt = nowIso();
    saveSettings();
    return chosen;
  }

  allLimited() {
    const l = this.list();
    return l.length > 0 && l.every((a) => this.isLimited(a));
  }

  /** A session reported a limit error. Without resetsAt, retry in 30 minutes. */
  markLimited(id: string | null, resetsAtMs?: number) {
    const a = this.get(id);
    if (!a) return;
    a.limitedUntil = new Date(resetsAtMs && resetsAtMs > Date.now() ? resetsAtMs : Date.now() + 30 * 60_000).toISOString();
    saveSettings();
    this.emit('changed');
  }

  /** Apply a rate_limit_event from the SDK. */
  applyEvent(id: string | null, info: { status?: string; rateLimitType?: string; utilization?: number; resetsAt?: number }) {
    const a = this.get(id);
    if (!a) return;
    const pct = typeof info.utilization === 'number' ? (info.utilization <= 1 ? info.utilization * 100 : info.utilization) : null;
    const resets = info.resetsAt ? new Date(info.resetsAt > 1e12 ? info.resetsAt : info.resetsAt * 1000).toISOString() : null;
    const win: UsageWindow | null = info.rateLimitType === 'five_hour' ? a.fiveHour : info.rateLimitType?.startsWith('seven_day') ? a.sevenDay : null;
    if (win && pct !== null) {
      win.utilization = Math.round(pct);
      if (resets) win.resetsAt = resets;
      a.usageUpdatedAt = nowIso();
      if (a.usageSource !== 'endpoint') a.usageSource = 'events';
    }
    if (info.status === 'rejected') this.markLimited(a.id, info.resetsAt ? (info.resetsAt > 1e12 ? info.resetsAt : info.resetsAt * 1000) : undefined);
    saveSettings();
    this.emit('changed');
  }

  /** Apply plan usage (5h, 7d) reported by a session. Fills accounts that can't use the endpoint. */
  applyUsage(id: string | null, rl: { five_hour?: { utilization: number | null; resets_at: string | null } | null; seven_day?: { utilization: number | null; resets_at: string | null } | null }) {
    const a = this.get(id);
    if (!a) return;
    const w = (x: any): UsageWindow | null => (x && typeof x.utilization === 'number' ? { utilization: Math.round(x.utilization), resetsAt: x.resets_at ?? null } : null);
    const f = w(rl.five_hour);
    const s = w(rl.seven_day);
    if (!f && !s) return;
    if (f) a.fiveHour = f;
    if (s) a.sevenDay = s;
    a.usageUpdatedAt = nowIso();
    if (a.kind !== 'token' || a.usageSource !== 'endpoint') a.usageSource = 'events';
    if (a.limitedUntil && Date.parse(a.limitedUntil) > Date.now() && this.score(a) < RED) a.limitedUntil = null;
    saveSettings();
    this.emit('changed');
  }

  /** Read 5h/7d usage for token accounts from the usage endpoint Claude Code uses. */
  async refresh(id?: string) {
    for (const a of this.list()) {
      if (id && a.id !== id) continue;
      if (a.kind !== 'token') continue;
      if (a.usageBackoffUntil && Date.parse(a.usageBackoffUntil) > Date.now()) continue;
      try {
        const res = await fetch(USAGE_URL, {
          headers: {
            Authorization: `Bearer ${decryptToken(a.tokenEnc)}`,
            'anthropic-beta': 'oauth-2025-04-20',
            'Content-Type': 'application/json',
          },
        });
        if (res.status === 429) {
          // The usage endpoint's own request limit, not the account's usage limit.
          // Keep the last values and back off (Retry-After, else 15 minutes).
          const ra = Number(res.headers.get('retry-after'));
          const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 15 * 60_000;
          a.usageBackoffUntil = new Date(Date.now() + wait).toISOString();
          a.lastError = null;
          log.info('usage endpoint 429', a.label, `retry in ${Math.round(wait / 60000)} min`);
          continue;
        }
        if (!res.ok) {
          a.lastError = res.status === 401 || res.status === 403
            ? t('acc.err.usageScope')
            : t('acc.err.usage', { msg: String(res.status) });
          continue;
        }
        const j: any = await res.json();
        const w = (x: any): UsageWindow => ({ utilization: typeof x?.utilization === 'number' ? Math.round(x.utilization) : null, resetsAt: x?.resets_at ?? null });
        a.fiveHour = w(j.five_hour);
        a.sevenDay = w(j.seven_day);
        a.usageUpdatedAt = nowIso();
        a.usageSource = 'endpoint';
        a.lastError = null;
        if (a.limitedUntil && Date.parse(a.limitedUntil) > Date.now() && this.score(a) < RED) a.limitedUntil = null;
      } catch (e) {
        a.lastError = t('acc.err.usage', { msg: (e as Error).message });
        log.warn('usage refresh', a.label, (e as Error).message);
      }
    }
    saveSettings();
    this.emit('changed');
  }

  startPolling() {
    void this.refresh();
    setInterval(() => void this.refresh(), 5 * 60_000).unref();
  }
}

export const accounts = new Accounts();
