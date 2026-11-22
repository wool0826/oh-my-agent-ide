import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { toolCommand } from './toolpath';
import { notFoundMessage } from '../shared/toolpath';

export const nowIso = () => new Date().toISOString();
export const uid = () => crypto.randomUUID();
export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const month = () => today().slice(0, 7);

/** `missing`: the program itself was not found (ENOENT), as opposed to running and failing. */
export interface RunResult { code: number; stdout: string; stderr: string; missing?: boolean }

/** Run a program without a shell. Never throws; reports failure through `code`. */
export function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<RunResult> {
  let env = opts.env ?? process.env;
  // End-to-end tests put a script in gh's place (test/e2e/gh-stub.mjs), run by this same executable as Node.
  if (cmd === 'gh' && process.env.OMA_GH_STUB) {
    args = [process.env.OMA_GH_STUB, ...args];
    cmd = process.execPath;
    env = { ...env, ELECTRON_RUN_AS_NODE: '1' };
  }
  const name = cmd;
  cmd = toolCommand(cmd);
  return new Promise((resolve) => {
    const p = execFile(cmd, args, {
      cwd: opts.cwd,
      env,
      timeout: opts.timeoutMs ?? 10 * 60_000,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      signal: opts.signal,
    }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0;
      // "spawn gh ENOENT" says nothing to the user: name what was searched and how to install it instead.
      // Not on Windows, where .cmd shims also fail this way while installed and the message there stays as it was.
      if ((err as any)?.code === 'ENOENT' && process.platform !== 'win32' && (!opts.cwd || fs.existsSync(opts.cwd))) return resolve({ code, stdout: '', stderr: notFoundMessage(name, String(env.PATH ?? '')), missing: true });
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') + (err && !stderr ? String(err.message) : '') });
    });
    // Nothing is ever typed in: a command that asks for input reads the end at once instead of waiting.
    p.stdin?.on('error', () => {});
    p.stdin?.end();
  });
}

export async function runOk(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<string> {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${(r.stderr || r.stdout).trim().slice(0, 800)}`);
  return r.stdout;
}

export function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) as T;
  } catch {
    return fallback;
  }
}

/** Write to a temp file and rename, so a crash mid-write never corrupts the file. */
export function writeJsonAtomic(file: string, data: unknown) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function debounce<T extends (...a: any[]) => void>(fn: T, ms: number): T {
  let t: NodeJS.Timeout | null = null;
  return ((...a: any[]) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => { t = null; fn(...a); }, ms);
  }) as T;
}

export function slug(s: string) {
  return s.toLowerCase().replace(/\.git$/, '').replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'repo';
}

export function oneLine(s: string, max = 160) {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/** Simple async queue: values pushed in come out through for-await. */
export class PushQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;
  push(v: T) {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: v, done: false });
    else this.items.push(v);
  }
  close() {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as any, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const v = this.items.shift();
        if (v !== undefined) return Promise.resolve({ value: v, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as any, done: true });
        return new Promise((r) => this.waiters.push(r));
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined as any, done: true });
      },
    };
  }
}
