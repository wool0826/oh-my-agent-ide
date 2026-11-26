/* eslint-disable @typescript-eslint/no-explicit-any -- Codex app-server messages are untyped JSON-RPC. */
import { toolCommand } from '../toolpath';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { JsonRpc } from './rpc';
import { log } from '../log';

/**
 * The app's connection to Codex: one `codex app-server` process (the user's own Codex CLI, signed in with their
 * ChatGPT account) that every Codex session shares. It is started on first use and again after it exits.
 * The app never sees the account's tokens: sign-in is `codex login`, outside the app.
 */

/** What a session hears about its thread. */
export interface ThreadSink {
  notify(method: string, params: any): void;
  /** A request about this thread (an approval, a call of one of the app's tools); what it returns is the answer. */
  request(method: string, params: any): Promise<unknown>;
  /** The process is gone; the thread can be resumed on the next one. */
  lost(): void;
}

/** What a session needs from the connection (a test passes its own). */
export interface CodexLink {
  request<T = any>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  /** Hear about one thread; the returned function stops it. */
  subscribe(threadId: string, sink: ThreadSink): () => void;
}

export interface CodexClientOptions {
  /** The Codex CLI to run. Default: `codex` on the PATH. */
  command?: string;
  version?: string;
}

const threadOf = (params: any): string | null => params?.threadId ?? params?.thread?.id ?? null;

/**
 * Emits 'rateLimits' (the account's usage snapshot), 'account' (sign-in or plan changed) and 'exit'.
 */
export class CodexClient extends EventEmitter implements CodexLink {
  private child: ChildProcess | null = null;
  private rpc: JsonRpc | null = null;
  private ready: Promise<void> | null = null;
  private sinks = new Map<string, ThreadSink>();

  constructor(private opts: CodexClientOptions = {}) { super(); }

  get running() { return !!this.child; }

  async request<T = any>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    await this.start();
    return this.rpc!.request<T>(method, params, timeoutMs);
  }

  subscribe(threadId: string, sink: ThreadSink) {
    this.sinks.set(threadId, sink);
    return () => { if (this.sinks.get(threadId) === sink) this.sinks.delete(threadId); };
  }

  /** Start the process and say hello. Safe to call again: one start is under way at a time. */
  start(): Promise<void> {
    return (this.ready ??= this.launch().catch((e) => { this.ready = null; throw e; }));
  }

  stop() {
    const child = this.child;
    this.child = null;
    this.ready = null;
    try { child?.kill(); } catch { /* already gone */ }
  }

  private async launch() {
    const command = this.opts.command?.trim() || 'codex';
    // On Windows the CLI is a .cmd shim, which only a shell can start. The arguments are fixed, never user text.
    const child = spawn(toolCommand(command), ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32', windowsHide: true });
    this.child = child;
    const rpc = new JsonRpc((line) => { try { child.stdin?.write(line); } catch { /* exiting */ } }, {
      onNotify: (method, params) => this.onNotify(method, params),
      onRequest: (method, params) => this.onRequest(method, params),
      onNoise: (line) => log.warn('[codex] unexpected output', line.slice(0, 200)),
    });
    this.rpc = rpc;
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => rpc.feed(d));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (d: string) => { const s = d.trim(); if (s) log.warn('[codex]', s.slice(0, 400)); });
    const gone = (why: string) => {
      if (this.child !== child) return;
      this.child = null;
      this.rpc = null;
      this.ready = null;
      rpc.failAll(why);
      const sinks = [...this.sinks.values()];
      this.sinks.clear();
      for (const s of sinks) { try { s.lost(); } catch (e) { log.warn('[codex] sink', (e as Error).message); } }
      this.emit('exit', why);
    };
    child.on('error', (e) => gone(`Codex could not be started (${e.message}). Is the Codex CLI installed?`));
    child.on('exit', (code) => gone(`Codex exited (${code ?? 'killed'})`));
    await rpc.request('initialize', {
      clientInfo: { name: 'oh-my-agent-ide', title: 'Oh My Agent IDE', version: this.opts.version ?? '0.0.0' },
      // The app's own tools reach Codex as dynamic tools, which the protocol still marks experimental.
      capabilities: { experimentalApi: true },
    }, 30_000);
    rpc.notify('initialized');
  }

  private onNotify(method: string, params: any) {
    if (method === 'account/rateLimits/updated') this.emit('rateLimits', params?.rateLimits ?? null);
    else if (method === 'account/updated') this.emit('account', params ?? null);
    const id = threadOf(params);
    const sink = id ? this.sinks.get(id) : undefined;
    if (!sink) return;
    try { sink.notify(method, params); } catch (e) { log.error('[codex] notification', method, (e as Error).message); }
  }

  private onRequest(method: string, params: any) {
    const id = threadOf(params);
    const sink = id ? this.sinks.get(id) : undefined;
    if (!sink) throw new Error(`No session for ${method}`);
    return sink.request(method, params);
  }
}

let shared: CodexClient | null = null;
/** The process every Codex session of the app shares. */
export function codexClient(opts?: CodexClientOptions): CodexClient {
  return (shared ??= new CodexClient(opts));
}
