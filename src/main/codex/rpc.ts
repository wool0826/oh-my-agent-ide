// JSON-RPC over lines of JSON, as `codex app-server` speaks it on stdio: requests and notifications go both ways.

export interface RpcError { code: number; message: string; data?: unknown }

export interface RpcHandlers {
  /** A notification from the other side. */
  onNotify(method: string, params: any): void;
  /** A request from the other side; what it returns (or throws) is sent back as the answer. */
  onRequest(method: string, params: any): Promise<unknown> | unknown;
  /** A line that is not JSON-RPC (logged by the owner). */
  onNoise?(line: string): void;
}

export class RpcFailure extends Error {
  constructor(readonly method: string, readonly rpc: RpcError) {
    super(`${method}: ${rpc.message}`);
  }
}

export class JsonRpc {
  private nextId = 0;
  private buffer = '';
  private pending = new Map<number, { method: string; resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  constructor(private write: (line: string) => void, private handlers: RpcHandlers) {}

  /** Ask the other side and wait for its answer. Rejects with RpcFailure on an error answer, or after `timeoutMs`. */
  request<T = any>(method: string, params?: unknown, timeoutMs = 120_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no answer after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params?: unknown) {
    this.send(params === undefined ? { method } : { method, params });
  }

  /** Output of the other side, in whatever pieces it arrives. */
  feed(chunk: string) {
    this.buffer += chunk;
    for (;;) {
      const i = this.buffer.indexOf('\n');
      if (i < 0) return;
      const line = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);
      if (line) this.line(line);
    }
  }

  /** The connection is gone: every request still waiting fails with `reason`. */
  failAll(reason: string) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`${p.method}: ${reason}`));
      this.pending.delete(id);
    }
  }

  private send(msg: unknown) {
    this.write(`${JSON.stringify(msg)}\n`);
  }

  private line(line: string) {
    let m: any;
    try { m = JSON.parse(line); } catch { this.handlers.onNoise?.(line); return; }
    if (!m || typeof m !== 'object') { this.handlers.onNoise?.(line); return; }
    const isAnswer = m.id !== undefined && m.method === undefined && ('result' in m || 'error' in m);
    if (isAnswer) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new RpcFailure(p.method, m.error));
      else p.resolve(m.result);
      return;
    }
    if (typeof m.method !== 'string') { this.handlers.onNoise?.(line); return; }
    if (m.id === undefined) { this.handlers.onNotify(m.method, m.params); return; }
    void this.answer(m.id, m.method, m.params);
  }

  private async answer(id: unknown, method: string, params: unknown) {
    try {
      const result = await this.handlers.onRequest(method, params);
      this.send({ id, result: result ?? {} });
    } catch (e) {
      this.send({ id, error: { code: -32000, message: (e as Error).message || String(e) } });
    }
  }
}
