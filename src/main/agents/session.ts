import { query, type CanUseTool, type McpServerConfig, type Options, type PermissionMode, type Query, type SDKMessage, type SDKStatusMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { accounts } from '../accounts';
import { claudeExecutable, pluginPath } from '../runtime';
import { log } from '../log';
import { PushQueue } from '../util';
import { SpendMeter, spendOf, type SessionSpend, type Spend } from '../../shared/spend';
import { COMPACT_AT, COMPACT_MIN_GROWTH, CONTEXT_WINDOW } from '../../shared/context';
import { compactCommand } from '../../shared/compactInstructions';
import { artifactEnv, CONNECTOR_CHECK_MS, connectorChanges, connectorSettings, toReconnect } from './connectors';
import { t } from '../i18n';

/** Compaction as the owner sees it: Claude Code's own (mid-turn) and the app's /compact alike. */
export type CompactEvent =
  | { phase: 'start'; tokens: number }
  | { phase: 'done'; from: number; to: number }
  /** limited: a usage limit stopped it. The account is held, and the compaction is retried on another account if one is free. */
  | { phase: 'failed'; error: string; limited: boolean };

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
  /** Workers load project settings so the repo's CLAUDE.md applies. */
  settingSources?: Options['settingSources'];
  effort?: Options['effort'];
  additionalDirectories?: string[];
  hooks?: Options['hooks'];
  tools?: Options['tools'];
  /** Default auto. plan = read-only until ExitPlanMode is approved. */
  permissionMode?: PermissionMode;
  /** Flag settings for this session (e.g. where Claude Code keeps its auto-memory). */
  settings?: Options['settings'];
  /** Subagents the session can start with the Agent tool (e.g. the self-review reviewer). */
  agents?: Options['agents'];
  /** Spend already counted for the resumed session (from onSpend), so the resumed totals are not counted twice. */
  spent?: SessionSpend | null;
  /** Context size from which the idle session is compacted after a turn, read when the turn ends. Default COMPACT_AT. */
  compactAt?: () => number;
  /** What the app's /compact asks the summary to keep (see shared/compactInstructions). */
  compactInstructions?: string;
  /** Extra environment for this session's Claude Code process, over the account's. */
  env?: NodeJS.ProcessEnv;
  /**
   * claude.ai connectors and the Artifact tool (connectors.ts): true keeps them on and reconnects connectors that
   * failed; false keeps them out. Unset leaves Claude Code's defaults.
   */
  connectors?: boolean;
}

export interface SessionEvents {
  onInit?(sessionId: string): void;
  onText?(text: string): void;
  onTool?(name: string, summary: string): void;
  /**
   * queued: more input is waiting, so another turn follows and settles what this one left open.
   * background: subagents, workflows or background shells the session started are still running; each one starts a turn
   * by itself when it settles.
   */
  onTurnEnd?(r: { text: string; isError: boolean; internal: boolean; queued?: boolean; background?: boolean }): void;
  /** What a turn cost (hidden turns and turns a usage limit cut off included; zero when it only set the baseline), before onTurnEnd. Keep `session` for `spent`. */
  onSpend?(turn: Spend, session: SessionSpend): void;
  onContext?(tokens: number): void;
  onAccount?(accountId: string | null): void;
  onStatus?(status: 'busy' | 'idle' | 'error', text: string): void;
  /** The number of background subagents/workflows (n) or shells/monitors (shells) still running changed (between turns too). */
  onBackground?(n: number, shells: number): void;
  onLimited?(): void;
  /** Sent after Stop, while the stopped turn was ending: the input queue was dropped, so the owner sends them again. */
  onResend?(texts: string[]): void;
  /** Compaction started or ended. A failed one never fails the turn: the conversation stays as it was. */
  onCompact?(e: CompactEvent): void;
}

function userMsg(text: string): SDKUserMessage {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
}

/**
 * Error text that says a usage limit stopped the request. Matched only against what Claude Code reports as the error
 * (a result's error text, a failed compaction, the process's own error), never the assistant's words: its work may
 * well mention issue #429 or a rate limiter.
 */
export const LIMIT_RE = /rate.?limit|usage limit|limit reached|\b429\b|5-hour|weekly limit|out of extra usage/i;

/** Turn ends Claude Code reports for a turn that was interrupted. */
const ABORTED = new Set(['aborted_streaming', 'aborted_tools']);

/** The session's flag settings plus the app's context window, so Claude Code compacts by itself before reaching it. */
/** A settings file path (a string) is passed as is: neither the context window nor the connector switch is added. */
export function sessionSettings(settings: Options['settings'], connectors?: boolean): Options['settings'] {
  if (typeof settings === 'string') return settings;
  return { ...(connectors === undefined ? {} : connectorSettings(connectors)), ...settings, autoCompactWindow: CONTEXT_WINDOW };
}

/**
 * One Claude Code session. Input comes through a queue so the conversation stays open;
 * when the account hits its limit, the same session is resumed with another account's token.
 */
export class AgentSession {
  cfg: SessionConfig;
  ev: SessionEvents;
  sessionId: string | null;
  contextTokens = 0;
  busy = false;
  closed = false;
  /** Background subagents and workflows still running in this session's process. */
  background = 0;
  /**
   * Background shells, monitors and MCP tasks still running in it (a test run or a build started in the background).
   * Each one wakes the session when it ends, like a subagent, but one may also run on indefinitely (a dev server).
   */
  shells = 0;
  private q: Query | null = null;
  private input: PushQueue<SDKUserMessage> | null = null;
  private pendingInternal = 0;
  private internalTurn = false;
  private turnText: string[] = [];
  /** This turn's assistant said a usage limit rejected it (the SDK's own error, not its text). */
  private limitHit = false;
  /** interrupt() was called during this turn: its error is the Stop, and input queued after it is dropped with it. */
  private interrupted = false;
  /** Sent after interrupt(), before the stopped turn ended: kept when the queue is dropped. */
  private afterStop: string[] = [];
  private failingOver = false;
  /** A compaction in progress, with the context size it started from. */
  private compacting: { from: number } | null = null;
  /**
   * The context at the first step after the last compaction (0 before any). A boundary reports less than the
   * next request really holds, so it is measured there.
   */
  private compactFloor = 0;
  private floorPending = false;
  /** Why a compaction failed during the current turn, until its result. */
  private compactFailure: string | null = null;
  /** Kept across restarts of the query (failover, a dead process): the resumed session continues its totals. */
  private meter: SpendMeter;

  constructor(cfg: SessionConfig, ev: SessionEvents) {
    this.cfg = cfg;
    this.ev = ev;
    this.sessionId = cfg.resume;
    this.meter = new SpendMeter(!!cfg.resume, cfg.resume && cfg.spent?.sessionId === cfg.resume ? cfg.spent.total : null);
  }

  get accountId() { return this.cfg.accountId; }

  /**
   * Before the session (re)starts, move it off an account a usage limit is holding.
   * False when every account is held, so it cannot start now.
   */
  ready(): boolean {
    if (this.q || accounts.isFree(this.cfg.accountId)) return true;
    const next = accounts.pick(this.cfg.accountId);
    if (!next) return false;
    this.cfg.accountId = next.id;
    return true;
  }

  start() {
    this.input = new PushQueue<SDKUserMessage>();
    // Background work belongs to the process; a new one starts with none.
    this.background = 0;
    this.shells = 0;
    // Connectors belong to the process too: the new one is looked at after its first turn, from scratch.
    this.lastConnectorCheck = 0;
    this.connectorSeen.clear();
    this.reconnectTried.clear();
    this.interrupted = false;
    this.limitHit = false;
    const options: Options = {
      model: this.cfg.model,
      cwd: this.cfg.cwd,
      env: artifactEnv({ ...accounts.env(this.cfg.accountId), ...this.cfg.env }, this.cfg.connectors),
      systemPrompt: { type: 'preset', preset: 'claude_code', append: this.cfg.systemAppend },
      permissionMode: this.cfg.permissionMode ?? 'auto',
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
      settings: sessionSettings(this.cfg.settings, this.cfg.connectors),
      agents: this.cfg.agents,
      resume: this.sessionId ?? undefined,
      pathToClaudeCodeExecutable: claudeExecutable(),
      stderr: (d) => log.warn(`[${this.cfg.label}]`, d.trim().slice(0, 500)),
    };
    this.q = query({ prompt: this.input, options });
    this.ev.onAccount?.(this.cfg.accountId);
    void this.consume(this.q);
  }

  send(text: string) {
    if (this.closed) throw new Error(t('err.sessionClosed'));
    if (!this.q) this.start();
    // A Stop that came after its turn had ended stops nothing later.
    if (!this.busy) this.interrupted = false;
    this.busy = true;
    this.ev.onStatus?.('busy', '');
    if (this.interrupted) this.afterStop.push(text);
    this.input!.push(userMsg(text));
  }

  private sendInternal(text: string) {
    this.pendingInternal += 1;
    this.busy = true;
    this.input!.push(userMsg(text));
  }

  /** Summarize the conversation so far (/compact). The turn is hidden from the chat. */
  compact() {
    if (this.closed) return;
    if (!this.q) this.start();
    this.requestCompact();
  }

  private requestCompact() {
    this.ev.onStatus?.('busy', '');
    this.beginCompact();
    this.sendInternal(compactCommand(this.cfg.compactInstructions));
  }

  private beginCompact() {
    this.compacting = { from: this.contextTokens };
    this.ev.onCompact?.({ phase: 'start', tokens: this.contextTokens });
  }

  /** A usage limit also holds the account, so the turn's result can retry the compaction on another one. */
  private failCompact(error: string) {
    this.compacting = null;
    this.compactFailure = error;
    const limited = LIMIT_RE.test(error);
    if (limited) accounts.markLimited(this.cfg.accountId);
    log.warn(`[${this.cfg.label}] compaction failed`, error.slice(0, 300));
    this.ev.onCompact?.({ phase: 'failed', error, limited });
  }

  /** Change the effort level, live if the session is running, otherwise for its next start. */
  setEffort(effort: Options['effort']) {
    if (!effort || effort === this.cfg.effort) return;
    this.cfg.effort = effort;
    if (this.q && typeof effort === 'string') {
      this.q.applyFlagSettings({ effortLevel: effort }).catch((e) => log.warn(`[${this.cfg.label}] effort`, (e as Error).message));
    }
  }

  /** Switch permission mode, live if the session is running, otherwise for its next start. */
  async setMode(mode: PermissionMode) {
    if ((this.cfg.permissionMode ?? 'auto') === mode) return;
    this.cfg.permissionMode = mode;
    if (this.q) await this.q.setPermissionMode(mode).catch((e) => log.warn(`[${this.cfg.label}] mode`, (e as Error).message));
  }

  async interrupt() {
    if (this.busy) this.interrupted = true;
    try { await this.q?.interrupt(); } catch { /* already finished */ }
  }

  /** The models Claude Code offers this session's account, or null when no session is running. */
  async supportedModels(): Promise<{ id: string; name: string }[] | null> {
    if (!this.q) return null;
    try {
      const list = await Promise.race([this.q.supportedModels(), new Promise<never>((_, no) => setTimeout(() => no(new Error('timeout')), 10_000))]);
      return list.map((m) => ({ id: m.resolvedModel ?? m.value, name: m.displayName }));
    } catch (e) {
      log.warn(`[${this.cfg.label}] models`, (e as Error).message);
      return null;
    }
  }

  close() {
    this.closed = true;
    this.input?.close();
    try { this.q?.close(); } catch { /* ignore */ }
    this.q = null;
  }

  private async consume(q: Query) {
    try {
      for await (const m of q) {
        if (q !== this.q) break;
        this.handle(m);
      }
      if (q === this.q && !this.closed && !this.failingOver) {
        // Ended while the input queue is open: the process died. The next send resumes it.
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
      if (LIMIT_RE.test(msg)) {
        accounts.markLimited(this.cfg.accountId);
        return void this.failover();
      }
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
          const meta = m.compact_metadata;
          const from = meta?.pre_tokens || this.compacting?.from || this.contextTokens;
          this.compacting = null;
          this.floorPending = true;
          this.contextTokens = meta?.post_tokens ?? Math.round(this.contextTokens / 4);
          this.ev.onContext?.(this.contextTokens);
          this.ev.onCompact?.({ phase: 'done', from, to: this.contextTokens });
        } else if (m.subtype === 'status') {
          // Claude Code reports its own compaction, and how any compaction ended, on status messages.
          const st = m as SDKStatusMessage;
          if (st.status === 'compacting' && !this.compacting) this.beginCompact();
          else if (st.compact_result === 'failed') this.failCompact(st.compact_error || 'compaction failed');
        } else if (m.subtype === 'local_command_output' && this.compacting && this.pendingInternal > 0) {
          // The app's /compact may answer here; its text says why it failed.
          this.turnText.push(m.content);
        } else if (m.subtype === 'background_tasks_changed') {
          const n = liveAgents(m.tasks);
          const sh = liveShells(m.tasks);
          if (n !== this.background || sh !== this.shells) {
            this.background = n;
            this.shells = sh;
            this.ev.onBackground?.(n, sh);
          }
        }
        return;
      case 'rate_limit_event':
        accounts.applyEvent(this.cfg.accountId, m.rate_limit_info as any);
        return;
      case 'assistant': {
        if (m.parent_tool_use_id) return;
        // A turn the session started by itself (a background subagent finished) is work too.
        if (!this.busy) {
          this.busy = true;
          this.ev.onStatus?.('busy', '');
        }
        if (!this.internalTurn && this.turnText.length === 0 && this.pendingInternal > 0) {
          this.internalTurn = true;
        }
        if (m.error === 'rate_limit') {
          accounts.markLimited(this.cfg.accountId);
          this.limitHit = true;
          return;
        }
        const u: any = m.message.usage;
        if (u) {
          const t = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
          if (t > 0) {
            this.contextTokens = t;
            if (this.floorPending) { this.compactFloor = t; this.floorPending = false; }
            this.ev.onContext?.(t);
          }
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
        this.countSpend(m);
        // A /compact that ends without a boundary did not compact. Claude Code says why in its text ("Error during compaction: ...").
        if (internal && this.compacting) this.failCompact(finalText || text || 'compaction failed');
        const compactLimited = internal && this.compactFailure !== null && LIMIT_RE.test(this.compactFailure);
        this.compactFailure = null;
        if (compactLimited) {
          void this.failover(true);
          return;
        }
        // A turn the user stopped ended for that reason, whatever it said; one a limit cut off says so in its error
        // (with is_error, a success result's text is the error), never in what the assistant wrote.
        const userStop = this.interrupted;
        const stopped = userStop || ABORTED.has((m as any).terminal_reason);
        const limitHit = this.limitHit;
        this.interrupted = false;
        this.limitHit = false;
        if (isError && !stopped && (limitHit || (m as any).api_error_status === 429 || LIMIT_RE.test(text))) {
          accounts.markLimited(this.cfg.accountId);
          void this.failover();
          return;
        }
        let queued = ((m as any).queued_turn_count ?? 0) > 0;
        // Stop means stop: what was sent after the stopped turn would start the next one, so it goes with it.
        const resend = this.afterStop;
        this.afterStop = [];
        if (queued && userStop) { this.dropQueued(); queued = false; }
        this.busy = queued;
        this.ev.onTurnEnd?.({ text: finalText || text, isError, internal, queued, background: this.background + this.shells > 0 });
        // What was sent once Stop was pressed is new work, not part of the stopped turn: it goes out after the
        // stopped turn has settled.
        if (resend.length && !this.q) {
          setImmediate(() => {
            if (this.closed) return;
            if (this.ev.onResend) this.ev.onResend(resend);
            else resend.forEach((r) => this.send(r));
          });
        }
        void this.readPlanUsage();
        void this.checkConnectors();
        // A failed /compact is not a failed turn: the session stays usable and its task goes on.
        const failed = isError && !internal;
        if (!this.busy) this.ev.onStatus?.(failed ? 'error' : 'idle', failed ? text.slice(0, 300) : '');
        // After onTurnEnd, so the owner's threshold sees what the turn settled (a finished task).
        const compactAt = this.cfg.compactAt?.() ?? COMPACT_AT;
        // Not again right after a compaction that left the context above the threshold.
        const grown = this.contextTokens - this.compactFloor >= COMPACT_MIN_GROWTH;
        if (!internal && !isError && this.contextTokens >= compactAt && grown && !this.busy) {
          log.info(`[${this.cfg.label}] context ${this.contextTokens} >= ${compactAt}, compacting`);
          this.requestCompact();
        }
        return;
      }
      default:
        return;
    }
  }

  /** total_cost_usd and modelUsage are running totals for the session; report only what this turn added. */
  private countSpend(m: Extract<SDKMessage, { type: 'result' }>) {
    const turn = this.meter.take(spendOf(m));
    if (!turn || !this.sessionId || !this.meter.total) return;
    this.ev.onSpend?.(turn, { sessionId: this.sessionId, total: this.meter.total });
  }

  /** After each turn, read this account's plan usage (experimental API; failures are ignored). */
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

  /**
   * After a turn, look at the claude.ai connectors (at most once a minute): log what changed, and reconnect one that
   * failed (at most every 5 minutes). Claude Code reconnects one that dropped by itself; one that needs a sign-in
   * stays so, and the agent says so when it needs it. Failures are ignored.
   */
  private lastConnectorCheck = 0;
  private connectorSeen = new Map<string, string>();
  private reconnectTried = new Map<string, number>();
  private async checkConnectors() {
    if (!this.q || !this.cfg.connectors || Date.now() - this.lastConnectorCheck < CONNECTOR_CHECK_MS) return;
    this.lastConnectorCheck = Date.now();
    const q = this.q;
    try {
      const st = await q.mcpServerStatus();
      // Closed or restarted meanwhile: these statuses are of a process that is gone.
      if (this.q !== q) return;
      for (const line of connectorChanges(st, this.connectorSeen)) log.info(`[${this.cfg.label}] connector ${line}`);
      for (const name of toReconnect(st, this.reconnectTried, Date.now())) {
        this.reconnectTried.set(name, Date.now());
        log.info(`[${this.cfg.label}] reconnecting ${name}`);
        void Promise.resolve().then(() => q.reconnectMcpServer(name)).catch((e) => log.warn(`[${this.cfg.label}] reconnect ${name}`, (e as Error).message));
      }
    } catch (e) {
      log.warn(`[${this.cfg.label}] connector status`, (e as Error).message);
    }
  }

  /**
   * Throw away input the session has not started on: the process (and its queue) is closed, and the next send
   * resumes the same conversation in a new one.
   */
  private dropQueued() {
    log.info(`[${this.cfg.label}] stopped; queued input dropped`);
    this.input?.close();
    try { this.q?.close(); } catch { /* ignore */ }
    this.q = null;
    this.input = null;
  }

  /** The current account hit its limit: resume the same session on another account. compact: retry the /compact the limit stopped. */
  private async failover(compact = false) {
    if (this.failingOver || this.closed) return;
    this.failingOver = true;
    try {
      const old = this.cfg.accountId;
      const next = accounts.pick(old);
      this.input?.close();
      try { this.q?.close(); } catch { /* ignore */ }
      this.q = null;
      if (!next) {
        // Every account is held by a limit: the owner picks this up again when the first one resets.
        this.busy = false;
        this.ev.onStatus?.('idle', '');
        // A failed compaction cut nothing off: it is tried again after a later turn, or by Claude Code mid-turn.
        if (!compact) this.ev.onLimited?.();
        return;
      }
      log.info(`[${this.cfg.label}] failover ${old} -> ${next.id}`);
      this.cfg.accountId = next.id;
      this.start();
      if (compact) return this.requestCompact();
      // The continued work should be visible, so this is not an internal turn.
      this.busy = true;
      this.input!.push(userMsg('This session was resumed on another account because of a usage limit. Continue the work where you left off.'));
    } finally {
      this.failingOver = false;
    }
  }
}

type BgTask = { task_type: string; ambient?: boolean };
const isAgent = (x: BgTask) => /agent|workflow/.test(x.task_type);

/** Background subagents and workflows in a background_tasks_changed list. Ambient tasks (watchers) are not activity. */
export function liveAgents(tasks: BgTask[]) {
  return tasks.filter((x) => !x.ambient && isAgent(x)).length;
}

/** The other live background tasks: shells, monitors, MCP tasks. Each wakes the session when it ends. */
export function liveShells(tasks: BgTask[]) {
  return tasks.filter((x) => !x.ambient && !isAgent(x)).length;
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
