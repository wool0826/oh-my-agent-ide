import { query, type CanUseTool, type McpServerConfig, type Options, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { accounts } from '../accounts';
import { claudeExecutable, pluginPath } from '../runtime';
import { log } from '../log';
import { PushQueue } from '../util';

/** 이 크기를 넘은 채로 턴이 끝나면 /compact를 보낸다. */
export const COMPACT_AT = 250_000;

export interface SessionConfig {
  label: string;
  model: string;
  cwd: string;
  systemAppend: string;
  accountId: string | null;
  resume: string | null;
  mcpServers?: Record<string, McpServerConfig>;
  canUseTool?: CanUseTool;
  disallowedTools?: string[];
  /** Worker는 저장소의 CLAUDE.md를 읽도록 project 설정을 불러온다. */
  settingSources?: Options['settingSources'];
  effort?: Options['effort'];
  additionalDirectories?: string[];
  hooks?: Options['hooks'];
  tools?: Options['tools'];
}

export interface SessionEvents {
  onInit?(sessionId: string): void;
  onText?(text: string): void;
  onTool?(name: string, summary: string): void;
  onTurnEnd?(r: { text: string; isError: boolean; costUsd: number; internal: boolean }): void;
  onContext?(tokens: number): void;
  onAccount?(accountId: string | null): void;
  onStatus?(status: 'busy' | 'idle' | 'error', text: string): void;
  onLimited?(): void;
}

function userMsg(text: string): SDKUserMessage {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
}

const LIMIT_RE = /rate.?limit|usage limit|limit reached|429|5-hour|weekly limit|out of extra usage/i;

/**
 * Claude Code 세션 하나. 입력을 큐로 받아 계속 이어지는 대화를 유지하고,
 * 계정 한도에 걸리면 다른 계정 토큰으로 같은 세션을 이어서 연다.
 */
export class AgentSession {
  cfg: SessionConfig;
  ev: SessionEvents;
  sessionId: string | null;
  contextTokens = 0;
  busy = false;
  closed = false;
  private q: Query | null = null;
  private input: PushQueue<SDKUserMessage> | null = null;
  private pendingInternal = 0;
  private internalTurn = false;
  private turnText: string[] = [];
  private failingOver = false;

  constructor(cfg: SessionConfig, ev: SessionEvents) {
    this.cfg = cfg;
    this.ev = ev;
    this.sessionId = cfg.resume;
  }

  get accountId() { return this.cfg.accountId; }

  start() {
    this.input = new PushQueue<SDKUserMessage>();
    const options: Options = {
      model: this.cfg.model,
      cwd: this.cfg.cwd,
      env: accounts.env(this.cfg.accountId),
      systemPrompt: { type: 'preset', preset: 'claude_code', append: this.cfg.systemAppend },
      permissionMode: 'auto',
      canUseTool: this.cfg.canUseTool,
      mcpServers: this.cfg.mcpServers,
      disallowedTools: this.cfg.disallowedTools,
      settingSources: this.cfg.settingSources ?? [],
      plugins: pluginPath() ? [{ type: 'local', path: pluginPath()! }] : undefined,
      skills: 'all',
      effort: this.cfg.effort,
      additionalDirectories: this.cfg.additionalDirectories,
      hooks: this.cfg.hooks,
      tools: this.cfg.tools,
      resume: this.sessionId ?? undefined,
      pathToClaudeCodeExecutable: claudeExecutable(),
      stderr: (d) => log.warn(`[${this.cfg.label}]`, d.trim().slice(0, 500)),
    };
    this.q = query({ prompt: this.input, options });
    this.ev.onAccount?.(this.cfg.accountId);
    void this.consume(this.q);
  }

  send(text: string) {
    if (this.closed) throw new Error('닫힌 세션이에요.');
    if (!this.q) this.start();
    this.busy = true;
    this.ev.onStatus?.('busy', '');
    this.input!.push(userMsg(text));
  }

  private sendInternal(text: string) {
    this.pendingInternal += 1;
    this.busy = true;
    this.input!.push(userMsg(text));
  }

  async interrupt() {
    try { await this.q?.interrupt(); } catch { /* 이미 끝남 */ }
  }

  close() {
    this.closed = true;
    this.input?.close();
    try { this.q?.close(); } catch { /* 무시 */ }
    this.q = null;
  }

  private async consume(q: Query) {
    try {
      for await (const m of q) {
        if (q !== this.q) break;
        this.handle(m);
      }
      if (q === this.q && !this.closed && !this.failingOver) {
        // 입력 큐가 닫히지 않았는데 끝났다면 프로세스가 죽은 것. 다음 send 때 resume으로 다시 연다.
        this.q = null;
        this.busy = false;
        this.ev.onStatus?.('idle', '');
      }
    } catch (e) {
      if (q !== this.q || this.closed) return;
      const msg = (e as Error).message ?? String(e);
      log.error(`[${this.cfg.label}] session error`, msg);
      this.q = null;
      this.busy = false;
      if (LIMIT_RE.test(msg)) return void this.failover();
      this.ev.onStatus?.('error', msg.slice(0, 300));
    }
  }

  private handle(m: SDKMessage) {
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') {
          this.sessionId = m.session_id;
          this.ev.onInit?.(m.session_id);
        } else if (m.subtype === 'compact_boundary') {
          this.contextTokens = (m as any).compact_metadata?.post_tokens ?? Math.round(this.contextTokens / 4);
          this.ev.onContext?.(this.contextTokens);
        }
        return;
      case 'rate_limit_event':
        accounts.applyEvent(this.cfg.accountId, m.rate_limit_info as any);
        return;
      case 'assistant': {
        if (m.parent_tool_use_id) return;
        if (!this.internalTurn && this.turnText.length === 0 && this.pendingInternal > 0) {
          this.internalTurn = true;
        }
        if (m.error === 'rate_limit') {
          accounts.markLimited(this.cfg.accountId);
          return;
        }
        const u: any = m.message.usage;
        if (u) {
          const t = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
          if (t > 0) { this.contextTokens = t; this.ev.onContext?.(t); }
        }
        for (const b of m.message.content as any[]) {
          if (b.type === 'text' && b.text?.trim()) {
            this.turnText.push(b.text);
            if (!this.internalTurn) this.ev.onText?.(b.text);
          } else if (b.type === 'tool_use') {
            this.ev.onTool?.(b.name, summarizeTool(b.name, b.input));
          }
        }
        return;
      }
      case 'result': {
        const isError = m.subtype !== 'success' || (m as any).is_error;
        const text = m.subtype === 'success' ? (m.result ?? '') : (m.errors ?? []).join('\n');
        const internal = this.internalTurn || this.pendingInternal > 0;
        if (internal) this.pendingInternal = Math.max(0, this.pendingInternal - 1);
        this.internalTurn = false;
        const finalText = this.turnText.length ? this.turnText[this.turnText.length - 1] : text;
        this.turnText = [];
        if (isError && LIMIT_RE.test(text + ' ' + finalText)) {
          accounts.markLimited(this.cfg.accountId);
          void this.failover();
          return;
        }
        const queued = (m as any).queued_turn_count ?? 0;
        this.busy = queued > 0;
        this.ev.onTurnEnd?.({ text: finalText || text, isError, costUsd: m.total_cost_usd ?? 0, internal });
        void this.readPlanUsage();
        if (!this.busy) this.ev.onStatus?.(isError ? 'error' : 'idle', isError ? text.slice(0, 300) : '');
        if (!internal && !isError && this.contextTokens > COMPACT_AT && !this.busy) {
          log.info(`[${this.cfg.label}] context ${this.contextTokens} > ${COMPACT_AT}, compacting`);
          this.sendInternal('/compact');
        }
        return;
      }
      default:
        return;
    }
  }

  /** 턴이 끝날 때마다 이 세션 계정의 요금제 사용량을 읽어 둔다(실험 API라 실패해도 조용히 넘어간다). */
  private lastUsageRead = 0;
  private async readPlanUsage() {
    if (!this.q || Date.now() - this.lastUsageRead < 60_000) return;
    this.lastUsageRead = Date.now();
    try {
      const u = await (this.q as any).usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?.({ skipBehaviors: true });
      if (u?.rate_limits_available && u.rate_limits) accounts.applyUsage(this.cfg.accountId, u.rate_limits);
    } catch (e) {
      log.warn(`[${this.cfg.label}] usage read`, (e as Error).message);
    }
  }

  /** 지금 계정이 한도에 걸렸을 때: 다른 계정으로 같은 세션을 이어 연다. */
  private async failover() {
    if (this.failingOver || this.closed) return;
    this.failingOver = true;
    try {
      const old = this.cfg.accountId;
      const next = accounts.pick(old);
      this.input?.close();
      try { this.q?.close(); } catch { /* 무시 */ }
      this.q = null;
      if (!next) {
        this.busy = false;
        this.ev.onLimited?.();
        this.ev.onStatus?.('error', '모든 계정이 사용량 한도에 걸렸어요. 한도가 풀리면 이어서 진행합니다.');
        return;
      }
      log.info(`[${this.cfg.label}] failover ${old} -> ${next.id}`);
      this.cfg.accountId = next.id;
      this.start();
      // 이어서 하는 작업은 사용자에게 보여야 하므로 내부 턴으로 표시하지 않는다.
      this.busy = true;
      this.input!.push(userMsg('사용량 한도 때문에 다른 계정으로 세션을 이어서 열었습니다. 하던 작업을 그대로 이어서 진행해 주세요.'));
    } finally {
      this.failingOver = false;
    }
  }

  /** 한도가 풀린 뒤 다시 시작할 때 쓴다. */
  resumeAfterLimit(text: string) {
    const next = accounts.pick();
    if (!next) return false;
    this.cfg.accountId = next.id;
    this.start();
    this.send(text);
    return true;
  }
}

export function summarizeTool(name: string, input: any, max = 140): string {
  try {
    switch (name) {
      case 'Bash': return `$ ${String(input.command ?? '').slice(0, max)}`;
      case 'Read': case 'Write': case 'Edit': case 'NotebookEdit': return `${name} ${input.file_path ?? input.notebook_path ?? ''}`;
      case 'Grep': return `Grep ${input.pattern ?? ''}`;
      case 'Glob': return `Glob ${input.pattern ?? ''}`;
      case 'WebFetch': return `WebFetch ${input.url ?? ''}`;
      case 'WebSearch': return `WebSearch ${input.query ?? ''}`;
      case 'Agent': case 'Task': return `Agent ${input.description ?? ''}`;
      default: return name.replace(/^mcp__board__/, '');
    }
  } catch {
    return name;
  }
}
