import { fakeMode } from './fake';
import { EventEmitter } from 'node:events';
import { loadSettings, saveSettings, encryptToken, decryptToken, type StoredAccount } from './settings';
import { log } from './log';
import { nowIso, uid } from './util';
import { t } from './i18n';
import { chooseAccount, clampUsageMins, isExhausted, limitEnd, liveWindow, nextFreeAtFor, type UsageClock } from '../shared/usage';
import { readUnifiedHeaders } from '../shared/usageHeaders';
import { MAX_ACCOUNTS, type AccountPlan, type AccountView, type Provider, type UsageWindow } from '../shared/types';
import { codexClient } from './codex/client';
import { limitWindows, type CodexRateLimits } from '../shared/codexEvents';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
/** The model of the one-token request that reads a token's usage headers: the cheapest one. */
const PROBE_MODEL = 'claude-haiku-5-5';

/** What one read of a token account came to. */
type Read = { ok: true } | { ok: false; status: number; retryAfter?: string | null; probe?: boolean };

class Accounts extends EventEmitter {
  /** The rounds of reading usage, for the popover's foot. */
  clock: UsageClock = { checkedAt: null, nextAt: null, running: false };
  private timer: NodeJS.Timeout | null = null;
  private round: Promise<void> | null = null;

  list(): StoredAccount[] {
    return loadSettings().accounts;
  }

  get(id: string | null) {
    return this.list().find((a) => a.id === id) ?? null;
  }

  views(): AccountView[] {
    return this.list().map((a) => ({
      id: a.id, label: a.label, kind: a.kind, plan: a.plan, provider: a.provider, planLabel: a.planLabel ?? null, windowMins: a.windowMins ?? null,
      fiveHour: liveWindow(a.fiveHour), sevenDay: liveWindow(a.sevenDay),
      usageUpdatedAt: a.usageUpdatedAt, usageSource: a.usageSource, usageBackoffUntil: a.usageBackoffUntil ?? null,
      limited: this.isLimited(a), limitedUntil: this.isLimited(a) ? a.limitedUntil : null, lastError: a.lastError,
    }));
  }

  add(label: string, kind: 'token' | 'login', token: string, plan: AccountPlan = 'team') {
    const s = loadSettings();
    if (s.accounts.length >= MAX_ACCOUNTS) throw new Error(t('acc.err.max', { n: MAX_ACCOUNTS }));
    if (kind === 'login' && s.accounts.some((a) => a.kind === 'login' && a.provider === 'claude')) throw new Error(t('acc.err.oneLogin'));
    const tok = token.trim();
    if (kind === 'token' && !/^sk-ant-/.test(tok)) throw new Error(t('acc.err.token'));
    const acc: StoredAccount = {
      id: uid(), label: label.trim() || t('acc.defaultName', { n: s.accounts.length + 1 }), kind, plan, provider: 'claude',
      tokenEnc: kind === 'token' ? encryptToken(tok) : '',
      fiveHour: { utilization: null, resetsAt: null }, sevenDay: { utilization: null, resetsAt: null },
      usageUpdatedAt: null, usageSource: null, limitedUntil: null, lastAssignedAt: null, lastError: null, usageBackoffUntil: null,
    };
    s.accounts.push(acc);
    saveSettings();
    this.emit('changed');
    // As a round, so an account added while one runs is not read twice.
    void this.refreshAll();
    return acc.id;
  }

  /**
   * Register this PC's Codex sign-in (a ChatGPT account). The app holds no token for it: Codex keeps the sign-in,
   * and the user signs in with `codex login`. One such account, since Codex has one sign-in.
   */
  async addChatgpt(label: string) {
    const s = loadSettings();
    if (s.accounts.length >= MAX_ACCOUNTS) throw new Error(t('acc.err.max', { n: MAX_ACCOUNTS }));
    if (s.accounts.some((a) => a.provider === 'chatgpt')) throw new Error(t('acc.err.oneChatgpt'));
    let signedIn = false;
    try {
      const r = await codexClient().request<{ account: unknown | null }>('account/read', { refreshToken: false }, 30_000);
      signedIn = !!r?.account;
    } catch (e) {
      log.warn('codex account', (e as Error).message);
      throw new Error(t('acc.err.codexMissing'));
    }
    if (!signedIn) throw new Error(t('acc.err.codexLogin'));
    const acc: StoredAccount = {
      id: uid(), label: label.trim() || 'ChatGPT', kind: 'login', plan: 'team', provider: 'chatgpt', planLabel: null, windowMins: null, tokenEnc: '',
      fiveHour: { utilization: null, resetsAt: null }, sevenDay: { utilization: null, resetsAt: null },
      usageUpdatedAt: null, usageSource: null, limitedUntil: null, lastAssignedAt: null, lastError: null, usageBackoffUntil: null,
    };
    s.accounts.push(acc);
    saveSettings();
    this.emit('changed');
    void this.refreshCodex();
    return acc.id;
  }

  /** The ChatGPT account, if one is registered. */
  chatgpt() {
    return this.list().find((a) => a.provider === 'chatgpt') ?? null;
  }

  /**
   * What Codex reports about the ChatGPT account's usage. A plan has one or two windows: the shorter one goes
   * where a Claude account has its 5-hour window, the longer (or only) one where it has the 7-day window.
   */
  applyCodex(rl: CodexRateLimits | null) {
    const a = this.chatgpt();
    if (!a || !rl) return;
    const wins = limitWindows(rl);
    const long = wins.length ? wins[wins.length - 1] : null;
    const short = wins.length > 1 ? wins[0] : null;
    a.fiveHour = short ? { utilization: short.utilization, resetsAt: short.resetsAt } : { utilization: null, resetsAt: null };
    a.sevenDay = long ? { utilization: long.utilization, resetsAt: long.resetsAt } : { utilization: null, resetsAt: null };
    a.windowMins = [short?.minutes ?? null, long?.minutes ?? null];
    a.planLabel = rl.planType ?? a.planLabel ?? null;
    a.usageUpdatedAt = nowIso();
    a.usageSource = 'endpoint';
    a.lastError = null;
    if (rl.rateLimitReachedType) {
      const full = wins.filter((w) => w.utilization >= 95 && w.resetsAt).map((w) => Date.parse(w.resetsAt!));
      this.markLimited(a.id, full.length ? Math.max(...full) : undefined);
    }
    saveSettings();
    this.emit('changed');
  }

  /** Read the ChatGPT account's usage from Codex. Starts the Codex process if it is not running. */
  async refreshCodex() {
    if (fakeMode()) return;
    const a = this.chatgpt();
    if (!a) return;
    try {
      const r = await codexClient().request<{ rateLimits: CodexRateLimits | null }>('account/rateLimits/read', undefined, 30_000);
      this.applyCodex(r?.rateLimits ?? null);
    } catch (e) {
      a.lastError = t('acc.err.usage', { msg: (e as Error).message });
      log.warn('codex usage', (e as Error).message);
      saveSettings();
      this.emit('changed');
    }
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
    env.CLAUDE_AGENT_SDK_CLIENT_APP = 'oh-my-agent-ide/0.6.2';
    const a = this.get(id);
    if (a?.kind === 'token') env.CLAUDE_CODE_OAUTH_TOKEN = decryptToken(a.tokenEnc);
    return env;
  }

  /** Only an account a usage limit actually rejected is limited, until that limit resets. High usage alone is not. */
  isLimited(a: StoredAccount) {
    return isExhausted(a);
  }

  /** The account exists and no limit is holding it. */
  isFree(id: string | null) {
    const a = this.get(id);
    return !!a && !this.isLimited(a);
  }

  /**
   * Pick an account for a new session: the lowest usage among accounts no limit is holding, however high;
   * within 5 points, the one assigned longest ago. `exclude` is the account that just hit its limit.
   * Null only when every account is held by a limit (or there are none).
   */
  pick(exclude?: string | null, provider: Provider = 'claude'): StoredAccount | null {
    const chosen = chooseAccount(this.list(), Date.now(), exclude, provider);
    if (!chosen) return null;
    chosen.lastAssignedAt = nowIso();
    saveSettings();
    return chosen;
  }

  allLimited() {
    const l = this.list();
    return l.length > 0 && l.every((a) => this.isLimited(a));
  }

  /**
   * When every account of `provider` is held by a limit: when the first one resets (ms). Otherwise null.
   * Without a provider: the first reset among providers that are fully held.
   */
  nextFreeAt(provider?: Provider) {
    return nextFreeAtFor(this.list(), provider);
  }

  /** A usage limit rejected this account. It is skipped until the limit resets (see limitEnd). */
  markLimited(id: string | null, resetsAtMs?: number) {
    const a = this.get(id);
    if (!a) return;
    let end = limitEnd(a, Date.now(), resetsAtMs);
    // A report without its own reset time never shortens one that had it (the rejection event comes first).
    if (!resetsAtMs && a.limitedUntil) end = Math.max(end, Date.parse(a.limitedUntil));
    a.limitedUntil = new Date(end).toISOString();
    log.info('usage limit', a.label, 'until', a.limitedUntil);
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
      if (a.usageSource !== 'endpoint' && a.usageSource !== 'probe') a.usageSource = 'events';
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
    if (a.kind !== 'token' || (a.usageSource !== 'endpoint' && a.usageSource !== 'probe')) a.usageSource = 'events';
    saveSettings();
    this.emit('changed');
  }

  /**
   * Read 5h/7d usage for token accounts: from the usage endpoint Claude Code uses, or, for a token the endpoint
   * refuses (an inference-only setup token), from the headers of a one-token request. The account remembers which.
   */
  async refresh(id?: string) {
    if (fakeMode()) return;
    for (const a of this.list()) {
      if (id && a.id !== id) continue;
      if (a.kind !== 'token' || a.provider !== 'claude') continue;
      if (a.usageBackoffUntil && Date.parse(a.usageBackoffUntil) > Date.now()) continue;
      try {
        let r = a.usageProbe ? await this.probe(a) : await this.readEndpoint(a);
        if (!r.ok && !a.usageProbe && (r.status === 401 || r.status === 403)) {
          r = await this.probe(a);
          if (r.ok) a.usageProbe = true;
        }
        if (r.ok) { a.lastError = null; continue; }
        // A probe that failed sends the next round to the endpoint again: the token may have been given its scope.
        if (r.probe && r.status !== 429) a.usageProbe = false;
        if (r.status === 429) {
          // The server's own request limit, not the account's usage limit.
          // Keep the last values and back off (Retry-After, else 15 minutes).
          const ra = Number(r.retryAfter);
          const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 15 * 60_000;
          a.usageBackoffUntil = new Date(Date.now() + wait).toISOString();
          a.lastError = null;
          log.info('usage 429', a.label, `retry in ${Math.round(wait / 60000)} min`);
          continue;
        }
        a.lastError = r.status === 401 || r.status === 403
          ? t('acc.err.usageScope')
          : r.probe
            // The model request itself failed (an unknown model, or an answer without the usage headers).
            ? t('acc.err.usageProbe', { msg: r.status ? String(r.status) : t('acc.err.noHeaders') })
            : t('acc.err.usage', { msg: String(r.status) });
      } catch (e) {
        a.lastError = t('acc.err.usage', { msg: (e as Error).message });
        log.warn('usage refresh', a.label, (e as Error).message);
      }
    }
    saveSettings();
    this.emit('changed');
  }

  private async readEndpoint(a: StoredAccount): Promise<Read> {
    const res = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${decryptToken(a.tokenEnc)}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) return { ok: false, status: res.status, retryAfter: res.headers.get('retry-after') };
    const j: any = await res.json();
    const w = (x: any): UsageWindow => ({ utilization: typeof x?.utilization === 'number' ? Math.round(x.utilization) : null, resetsAt: x?.resets_at ?? null });
    a.fiveHour = w(j.five_hour);
    a.sevenDay = w(j.seven_day);
    a.usageUpdatedAt = nowIso();
    a.usageSource = 'endpoint';
    return { ok: true };
  }

  /**
   * A one-token request to the cheapest model, sent as Claude Code (an OAuth token serves Claude Code only), for the
   * usage headers on its answer. A refusal by a usage limit carries them too: then the account is limited.
   */
  private async probe(a: StoredAccount): Promise<Read> {
    const res = await fetch(MESSAGES_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${decryptToken(a.tokenEnc)}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: PROBE_MODEL,
        max_tokens: 1,
        system: "You are Claude Code, Anthropic's official CLI for Claude.",
        messages: [{ role: 'user', content: '.' }],
      }),
    });
    // The answer itself is not needed.
    void res.body?.cancel().catch(() => {});
    const u = readUnifiedHeaders((n) => res.headers.get(n));
    if (!u || (!u.fiveHour && !u.sevenDay && !u.rejected)) return { ok: false, status: res.ok ? 0 : res.status, retryAfter: res.headers.get('retry-after'), probe: true };
    if (u.fiveHour) a.fiveHour = u.fiveHour;
    if (u.sevenDay) a.sevenDay = u.sevenDay;
    a.usageUpdatedAt = nowIso();
    a.usageSource = 'probe';
    if (u.rejected) this.markLimited(a.id, u.rejectedUntil ?? undefined);
    return { ok: true };
  }

  /**
   * One round: every token account and the ChatGPT account. A round asked for while one runs joins it. Afterwards
   * the next round is set from now, so a refresh by hand also moves the next one.
   */
  refreshAll(): Promise<void> {
    if (this.round) return this.round;
    this.clock.running = true;
    this.emit('changed');
    this.round = (async () => {
      try {
        await Promise.all([this.refresh(), this.refreshCodex()]);
      } finally {
        this.clock.checkedAt = nowIso();
        this.clock.running = false;
        this.round = null;
        this.arm();
        this.emit('changed');
      }
    })();
    return this.round;
  }

  /** Set the next round from the interval in Settings; none when it is "only by hand". */
  arm() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const mins = clampUsageMins(loadSettings().usageRefreshMins);
    this.clock.nextAt = mins ? new Date(Date.now() + mins * 60_000).toISOString() : null;
    if (mins) {
      this.timer = setTimeout(() => { void this.refreshAll(); }, mins * 60_000);
      this.timer.unref();
    }
  }

  startPolling() {
    // Fake agents: no usage to read and no Codex CLI to start; a round only moves the clock.
    if (!fakeMode()) codexClient().on('rateLimits', (rl: CodexRateLimits | null) => this.applyCodex(rl));
    void this.refreshAll();
  }
}

export const accounts = new Accounts();
