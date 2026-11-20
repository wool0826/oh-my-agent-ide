import { EventEmitter } from 'node:events';
import { loadSettings, saveSettings, encryptToken, decryptToken, type StoredAccount } from './settings';
import { log } from './log';
import { nowIso, uid } from './util';
import type { AccountView, UsageWindow } from '../shared/types';

/** 사용량이 이 값(%)을 넘으면 새 작업을 배정하지 않고, 진행 중 작업은 다른 계정으로 넘긴다. */
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
      id: a.id, label: a.label, kind: a.kind,
      fiveHour: a.fiveHour, sevenDay: a.sevenDay,
      usageUpdatedAt: a.usageUpdatedAt, usageSource: a.usageSource,
      limited: this.isLimited(a), lastError: a.lastError,
    }));
  }

  add(label: string, kind: 'token' | 'login', token: string) {
    const s = loadSettings();
    if (kind === 'login' && s.accounts.some((a) => a.kind === 'login')) throw new Error('이 PC 로그인 계정은 하나만 등록할 수 있어요.');
    const t = token.trim();
    if (kind === 'token' && !/^sk-ant-/.test(t)) throw new Error('claude setup-token으로 받은 sk-ant-로 시작하는 토큰을 붙여 넣어 주세요.');
    const acc: StoredAccount = {
      id: uid(), label: label.trim() || `계정 ${s.accounts.length + 1}`, kind,
      tokenEnc: kind === 'token' ? encryptToken(t) : '',
      fiveHour: { utilization: null, resetsAt: null }, sevenDay: { utilization: null, resetsAt: null },
      usageUpdatedAt: null, usageSource: null, limitedUntil: null, lastAssignedAt: null, lastError: null,
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

  /** Claude Code 프로세스에 줄 환경 변수. login 계정은 기존 로그인을 그대로 쓴다. */
  env(id: string | null): NodeJS.ProcessEnv {
    // Claude Code 터미널에서 앱을 띄우면 그 세션의 환경 변수가 따라온다. 자식 세션이 부모로 착각하지 않게 걷어 낸다.
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k === 'CLAUDE_CONFIG_DIR' || k === 'ANTHROPIC_BASE_URL') { env[k] = v; continue; }
      if (/^(CLAUDECODE|CLAUDE_|AI_AGENT$|MCP_CONNECTION|MCP_SERVER_CONNECTION|BAGGAGE$|ANTHROPIC_API_KEY$|ANTHROPIC_AUTH_TOKEN$)/.test(k)) continue;
      env[k] = v;
    }
    env.CLAUDE_AGENT_SDK_CLIENT_APP = 'oh-my-agent-ide/0.1.0';
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
   * 새 세션에 쓸 계정을 고른다. 한도에 걸리지 않은 계정 중 사용량이 가장 낮은 곳,
   * 비슷하면(5%p 이내) 가장 오래전에 배정한 곳. exclude는 방금 한도에 걸린 계정.
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

  /** 세션이 한도 오류를 냈을 때. resetsAt을 모르면 30분 뒤 다시 시도한다. */
  markLimited(id: string | null, resetsAtMs?: number) {
    const a = this.get(id);
    if (!a) return;
    a.limitedUntil = new Date(resetsAtMs && resetsAtMs > Date.now() ? resetsAtMs : Date.now() + 30 * 60_000).toISOString();
    saveSettings();
    this.emit('changed');
  }

  /** SDK의 rate_limit_event로 들어온 값을 반영한다. */
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

  /** 세션이 알려 준 요금제 사용량(5시간, 7일)을 반영한다. 엔드포인트를 못 쓰는 계정도 이걸로 채워진다. */
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

  /** 토큰 계정의 5시간/7일 사용량을 Claude Code가 쓰는 사용량 엔드포인트에서 읽는다. */
  async refresh(id?: string) {
    for (const a of this.list()) {
      if (id && a.id !== id) continue;
      if (a.kind !== 'token') continue;
      try {
        const res = await fetch(USAGE_URL, {
          headers: {
            Authorization: `Bearer ${decryptToken(a.tokenEnc)}`,
            'anthropic-beta': 'oauth-2025-04-20',
            'Content-Type': 'application/json',
          },
        });
        if (!res.ok) {
          a.lastError = res.status === 401 || res.status === 403
            ? '사용량 조회 권한이 없는 토큰이에요. 작업 중 들어오는 한도 정보로 대신 표시합니다.'
            : `사용량 조회 실패 (${res.status})`;
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
        a.lastError = `사용량 조회 실패: ${(e as Error).message}`;
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
