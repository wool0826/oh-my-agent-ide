/* eslint-disable @typescript-eslint/no-explicit-any -- Codex app-server messages are untyped JSON-RPC, read field by field. */
import { accounts } from '../accounts';
import { log } from '../log';
import type { CodexLink, ThreadSink } from '../codex/client';
import { SpendMeter, type SessionSpend } from '../../shared/spend';
import { commandShell, isUsageLimit, itemTool, plainCommand, usageSpend, type CodexItem, type CodexUsage } from '../../shared/codexEvents';
import type { SessionEvents } from './session';
import type { Shell } from '../../shared/shellWords';
import { t } from '../i18n';

/** A tool of the app that a Codex session can call (the Dispatcher's and the Workers' own tools). */
export interface CodexTool {
  name: string;
  description: string;
  /** JSON Schema of the arguments. */
  inputSchema: Record<string, unknown>;
  /** What the tool answers. Throwing answers with the error's message, marked as a failure. */
  run(args: any): Promise<string> | string;
}

/** Something Codex will not do without a yes: a command to run, or files to change. */
export type CodexApproval =
  | { kind: 'command'; command: string; shell: Shell; cwd: string | null; reason: string | null }
  | { kind: 'files'; files: string[]; reason: string | null };

export type CodexDecision = 'accept' | 'acceptForSession' | 'decline';

export interface CodexSessionConfig {
  label: string;
  model: string;
  cwd: string;
  /** The role's instructions (what `systemAppend` is for a Claude session). */
  instructions: string;
  accountId: string | null;
  /** The thread to continue, from an earlier onInit. */
  resume: string | null;
  effort?: string;
  tools?: CodexTool[];
  /** Asked before a command runs or files change, when Codex's own rules do not already allow it. No handler: declined. */
  approve?(req: CodexApproval, signal: AbortSignal): Promise<CodexDecision>;
  /** What the session may touch without asking. Default workspace-write: files under `cwd`. */
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  /** When Codex asks first. Default on-request. */
  approvalPolicy?: 'untrusted' | 'on-request' | 'never';
  /** Spend already counted for the resumed thread, so its totals are not counted twice. */
  spent?: SessionSpend | null;
}

/**
 * One Codex thread, with the surface the app's owners use on a Claude session (send, interrupt, compact, close and
 * the SessionEvents). Messages sent while a turn runs wait and go out together as the next turn.
 */
export class CodexSession {
  cfg: CodexSessionConfig;
  ev: SessionEvents;
  sessionId: string | null;
  contextTokens = 0;
  busy = false;
  closed = false;
  /** Codex has no background subagents that outlive a turn. */
  readonly background = 0;
  readonly shells = 0;
  private turnId: string | null = null;
  private queue: string[] = [];
  private pumping = false;
  private attached = false;
  private detach: (() => void) | null = null;
  private turnText: string[] = [];
  private turnError: { message: string; info: unknown } | null = null;
  private usageTotal: CodexUsage | null = null;
  private compacting: { from: number } | null = null;
  private files = new Map<string, string[]>();
  private meter: SpendMeter;

  constructor(cfg: CodexSessionConfig, ev: SessionEvents, private link: CodexLink) {
    this.cfg = cfg;
    this.ev = ev;
    this.sessionId = cfg.resume;
    this.meter = new SpendMeter(!!cfg.resume, cfg.resume && cfg.spent?.sessionId === cfg.resume ? cfg.spent.total : null);
  }

  get accountId() { return this.cfg.accountId; }

  /** False while the account's usage limit holds it: a Codex thread stays with the account that started it. */
  ready(): boolean {
    return this.attached || accounts.isFree(this.cfg.accountId);
  }

  send(text: string) {
    if (this.closed) throw new Error(t('err.sessionClosed'));
    this.busy = true;
    this.ev.onStatus?.('busy', '');
    this.queue.push(text);
    void this.pump();
  }

  /** Summarize the conversation so far. Codex also does this by itself as the context fills. */
  compact() {
    if (this.closed || !this.attached || !this.sessionId || this.turnId) return;
    this.compacting = { from: this.contextTokens };
    this.ev.onCompact?.({ phase: 'start', tokens: this.contextTokens });
    this.link.request('thread/compact/start', { threadId: this.sessionId }).catch((e) => {
      this.compacting = null;
      this.ev.onCompact?.({ phase: 'failed', error: (e as Error).message, limited: false });
    });
  }

  /** Used from the next turn on. */
  setEffort(effort: string | undefined) {
    if (effort) this.cfg.effort = effort;
  }

  /** Claude's permission modes do not exist here; the sandbox and approval policy are fixed when the thread starts. */
  async setMode(_mode: string) { /* nothing to switch */ }

  /** Aborted when the turn is interrupted or the session closes, so an open approval card does not outlive it. */
  private approvals = new AbortController();

  async interrupt() {
    this.approvals.abort();
    this.approvals = new AbortController();
    if (!this.sessionId || !this.turnId) return;
    try { await this.link.request('turn/interrupt', { threadId: this.sessionId, turnId: this.turnId }, 15_000); } catch { /* already finished */ }
  }

  /** The model list is read from the connection (model/list), not from a session. */
  async supportedModels(): Promise<{ id: string; name: string }[] | null> { return null; }

  close() {
    this.closed = true;
    void this.interrupt();
    this.detach?.();
    this.detach = null;
    this.attached = false;
    this.queue = [];
  }

  private async pump() {
    if (this.pumping || this.turnId || !this.queue.length || this.closed) return;
    this.pumping = true;
    try {
      await this.ensureThread();
      if (this.closed) return;
      const texts = this.queue.splice(0);
      this.turnText = [];
      this.turnError = null;
      const r = await this.link.request<{ turn: { id: string } }>('turn/start', {
        threadId: this.sessionId,
        input: texts.map((text) => ({ type: 'text', text, text_elements: [] })),
        model: this.cfg.model,
        ...(this.cfg.effort ? { effort: this.cfg.effort } : {}),
      });
      // The turn may already have ended by the time this answer is read.
      if (this.busy && !this.turnId) this.turnId = r.turn.id;
    } catch (e) {
      this.fail((e as Error).message ?? String(e));
    } finally {
      this.pumping = false;
    }
  }

  /** Start the thread, or pick the saved one up again. A thread that cannot be resumed is replaced by a new one. */
  private async ensureThread() {
    if (this.attached && this.sessionId) return;
    const params = {
      model: this.cfg.model,
      cwd: this.cfg.cwd,
      approvalPolicy: this.cfg.approvalPolicy ?? 'on-request',
      sandbox: this.cfg.sandbox ?? 'workspace-write',
      developerInstructions: this.cfg.instructions,
      dynamicTools: (this.cfg.tools ?? []).map((t) => ({ type: 'function', name: t.name, description: t.description, inputSchema: t.inputSchema })),
    };
    let thread: { id: string } | null = null;
    if (this.sessionId) {
      try {
        thread = (await this.link.request<{ thread: { id: string } }>('thread/resume', { threadId: this.sessionId, ...params, excludeTurns: true })).thread;
      } catch (e) {
        log.warn(`[${this.cfg.label}] thread ${this.sessionId} could not be resumed, starting a new one:`, (e as Error).message);
      }
    }
    thread ??= (await this.link.request<{ thread: { id: string } }>('thread/start', params)).thread;
    this.sessionId = thread.id;
    this.detach?.();
    this.detach = this.link.subscribe(thread.id, this.sink);
    this.attached = true;
    this.ev.onInit?.(thread.id);
    this.ev.onAccount?.(this.cfg.accountId);
  }

  private sink: ThreadSink = {
    notify: (method, params) => this.onNotify(method, params),
    request: (method, params) => this.onRequest(method, params),
    lost: () => {
      // The process died. The thread is on disk: the next message resumes it.
      this.attached = false;
      this.detach = null;
      this.turnId = null;
      if (this.closed) return;
      this.busy = this.queue.length > 0;
      if (!this.busy) this.ev.onStatus?.('idle', '');
    },
  };

  private onNotify(method: string, p: any) {
    switch (method) {
      case 'turn/started':
        this.turnId = p?.turn?.id ?? this.turnId;
        if (!this.busy) { this.busy = true; this.ev.onStatus?.('busy', ''); }
        return;
      case 'item/started': {
        const item = p?.item as CodexItem | undefined;
        if (!item) return;
        if (item.type === 'fileChange' && item.id) this.files.set(item.id, (item.changes ?? []).map((c) => c.path));
        const tool = itemTool(item);
        if (tool) this.ev.onTool?.(tool.name, tool.summary);
        return;
      }
      case 'item/completed': {
        const item = p?.item as CodexItem | undefined;
        if (item?.type === 'agentMessage' && item.text?.trim()) {
          this.turnText.push(item.text);
          this.ev.onText?.(item.text);
        }
        if (item?.id) this.files.delete(item.id);
        return;
      }
      case 'thread/tokenUsage/updated': {
        const u = p?.tokenUsage;
        this.usageTotal = u?.total ?? this.usageTotal;
        const now = u?.last?.totalTokens;
        if (typeof now === 'number' && now > 0) {
          this.contextTokens = now;
          this.ev.onContext?.(now);
          if (this.compacting && !this.turnId) this.endCompact();
        }
        return;
      }
      case 'thread/compacted':
        // Codex's own compaction mid-turn, or the one compact() asked for. The new size comes with the next usage report.
        this.compacting ??= { from: this.contextTokens };
        return;
      case 'error':
        if (!p?.willRetry && p?.error) this.turnError = { message: String(p.error.message ?? ''), info: p.error.codexErrorInfo };
        return;
      case 'turn/completed':
        this.endTurn(p?.turn ?? {});
        return;
      default:
        return;
    }
  }

  private endCompact() {
    const from = this.compacting?.from ?? this.contextTokens;
    this.compacting = null;
    this.ev.onCompact?.({ phase: 'done', from, to: this.contextTokens });
  }

  private endTurn(turn: { status?: string; error?: { message?: string; codexErrorInfo?: unknown } | null }) {
    this.turnId = null;
    const err = turn.error ? { message: String(turn.error.message ?? ''), info: turn.error.codexErrorInfo } : this.turnError;
    this.turnError = null;
    const said = this.turnText.length ? this.turnText[this.turnText.length - 1] : '';
    this.turnText = [];
    const spent = this.meter.take(usageSpend(this.usageTotal));
    if (spent && this.sessionId && this.meter.total) this.ev.onSpend?.(spent, { sessionId: this.sessionId, total: this.meter.total });
    if (this.compacting) this.endCompact();
    if (turn.status === 'failed' && isUsageLimit(err?.info)) {
      // The plan's allowance is used up. The thread belongs to this account, so the owner continues it after the reset.
      accounts.markLimited(this.cfg.accountId);
      this.busy = false;
      this.ev.onStatus?.('idle', '');
      this.ev.onLimited?.();
      return;
    }
    const isError = turn.status === 'failed';
    const text = isError ? (err?.message || said || 'Codex failed without a message.') : said;
    const queued = this.queue.length > 0 && !this.closed;
    this.busy = queued;
    this.ev.onTurnEnd?.({ text, isError, internal: false, queued, background: false });
    if (!this.busy) this.ev.onStatus?.(isError ? 'error' : 'idle', isError ? text.slice(0, 300) : '');
    if (queued) void this.pump();
  }

  /** A start or a send that Codex refused: the session stays usable, and what was waiting is dropped with the error. */
  private fail(message: string) {
    log.error(`[${this.cfg.label}] codex`, message);
    this.turnId = null;
    this.queue = [];
    this.busy = false;
    if (!this.closed) this.ev.onStatus?.('error', message.slice(0, 300));
  }

  private async onRequest(method: string, p: any): Promise<unknown> {
    switch (method) {
      case 'item/tool/call': {
        const tool = this.cfg.tools?.find((t) => t.name === p?.tool);
        const reply = (text: string, success: boolean) => ({ contentItems: [{ type: 'inputText', text }], success });
        if (!tool) return reply(`Unknown tool: ${p?.tool}`, false);
        try {
          return reply(String(await tool.run(p?.arguments ?? {})), true);
        } catch (e) {
          return reply((e as Error).message || String(e), false);
        }
      }
      case 'item/commandExecution/requestApproval':
        return { decision: await this.ask({ kind: 'command', command: plainCommand(String(p?.command ?? '')), shell: commandShell(String(p?.command ?? '')), cwd: p?.cwd ?? null, reason: p?.reason ?? null }) };
      case 'item/fileChange/requestApproval':
        return { decision: await this.ask({ kind: 'files', files: this.files.get(p?.itemId) ?? [], reason: p?.reason ?? null }) };
      case 'item/tool/requestUserInput':
        // Questions for the user go through the app's own ask tools, which the instructions name.
        return { answers: {} };
      default:
        throw new Error(`${method} is not supported by this app`);
    }
  }

  private async ask(req: CodexApproval): Promise<CodexDecision> {
    if (!this.cfg.approve) return 'decline';
    try {
      return await this.cfg.approve(req, this.approvals.signal);
    } catch (e) {
      log.warn(`[${this.cfg.label}] approval`, (e as Error).message);
      return 'decline';
    }
  }
}
