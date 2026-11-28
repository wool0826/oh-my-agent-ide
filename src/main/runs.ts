import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { store } from './store';
import { ghEnv } from './repos';
import { t } from './i18n';
import { log } from './log';
import { nowIso } from './util';
import { appendOutput, localUrl } from '../shared/runOutput';
import { portCandidates, psPrelude, runEnv, workerPort } from '../shared/runEnv';
import type { RunView } from '../shared/types';

/**
 * A repository's run command (a dev server, the app itself) started in a Worker's worktree, so the user can try the
 * Worker's change. One run per Worker. It belongs to this session of the app: nothing is stored (the window is told
 * without a save of the state), and quitting stops it.
 */
class Runs {
  private procs = new Map<string, { proc: ChildProcess; view: RunView; out: string }>();
  private pushTimer: NodeJS.Timeout | null = null;
  /** Workers whose run is looking for a free port, so a second click does not start it twice. */
  private starting = new Set<string>();
  /** Port searches run one at a time, and a port found stays reserved until its run is listed: two runs started together never get the same one. */
  private portQueue: Promise<unknown> = Promise.resolve();
  private reserved = new Set<number>();

  views(): RunView[] {
    return [...this.procs.values()].map((r) => r.view);
  }

  async start(workerId: string) {
    const w = store.worker(workerId);
    const repo = w?.repo ? store.repo(w.repo) : null;
    const cmd = repo?.run?.trim();
    if (!w || !repo || !cmd) throw new Error(t('run.err.none'));
    if (this.procs.get(workerId)?.view.running || this.starting.has(workerId)) return;
    this.starting.add(workerId);
    // The Worker's own port, or the next free one above it when something else holds it (13A).
    const want = workerPort(repo, w.id);
    let port = want;
    try { if (want) port = (await this.pickPort(want)) ?? want; } finally { this.starting.delete(workerId); }
    const vars = runEnv({ repoPath: repo.path, workerId: w.id, worktree: w.cwd, port });
    const win = process.platform === 'win32';
    const line = win ? psPrelude(vars.map(([k]) => k)) + cmd : cmd;
    const proc = spawn(win ? 'powershell.exe' : (process.env.SHELL || '/bin/sh'), win ? ['-NoProfile', '-NonInteractive', '-Command', line] : ['-lc', line], {
      cwd: w.cwd, env: { ...ghEnv(), ...Object.fromEntries(vars), OMA_ROOT_PATH: repo.path }, windowsHide: true,
      // Its own process group, so stopping it also stops what it started (a dev server behind npm).
      detached: !win,
    });
    const entry = { proc, out: '', view: { workerId, running: true, code: null, tail: '', url: null, startedAt: nowIso(), ...(port ? { port } : {}), ...(want && port !== want ? { busyPort: want } : {}) } as RunView };
    this.procs.set(workerId, entry);
    if (port) this.reserved.delete(port);
    const keep = (d: Buffer) => {
      entry.out = appendOutput(entry.out, d.toString());
      entry.view.tail = entry.out;
      entry.view.url ??= localUrl(entry.out);
      this.pushSoon();
    };
    proc.stdout?.on('data', keep);
    proc.stderr?.on('data', keep);
    let ended = false;
    const end = (code: number | null, note = '') => {
      if (ended) return;
      ended = true;
      entry.view.running = false;
      entry.view.code = code;
      if (note) entry.view.tail = appendOutput(entry.out, `${note}\n`);
      log.info(`run in ${w.cwd} exited`, code);
      store.emit('changed');
    };
    proc.on('error', (e) => end(1, e.message));
    proc.on('close', (code) => end(code));
    log.info(`run started in ${w.cwd}`, cmd);
    store.emit('changed');
  }

  /** The first free port from `want` up that no other run was given, reserved until the caller lists its run. */
  private pickPort(want: number): Promise<number | null> {
    const next = this.portQueue.then(async () => {
      const held = new Set([...this.reserved, ...[...this.procs.values()].filter((r) => r.view.running).map((r) => r.view.port)]);
      const p = await firstFree(portCandidates(want).filter((x) => !held.has(x)));
      if (p) this.reserved.add(p);
      return p;
    });
    this.portQueue = next.catch(() => null);
    return next;
  }

  stop(workerId: string) {
    const r = this.procs.get(workerId);
    if (!r?.view.running || !r.proc.pid) return;
    r.view.stopped = true;
    kill(r.proc);
  }

  /** Forget a finished run, so its output leaves the Worker view. */
  clear(workerId: string) {
    const r = this.procs.get(workerId);
    if (r && !r.view.running) { this.procs.delete(workerId); store.emit('changed'); }
  }

  stopAll() {
    for (const r of this.procs.values()) if (r.view.running) kill(r.proc);
  }

  /** Output arrives in bursts; the window gets it at most a few times a second. */
  private pushSoon() {
    if (this.pushTimer) return;
    this.pushTimer = setTimeout(() => { this.pushTimer = null; store.emit('changed'); }, 300);
  }
}

/** Whether the port can be bound on this host and address (dev servers bind loopback or every address, IPv4 or IPv6). */
function portFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (e: NodeJS.ErrnoException) => resolve(e.code === 'EADDRNOTAVAIL' || e.code === 'EAFNOSUPPORT'));
    srv.listen({ port, host, exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

async function firstFree(ports: number[]): Promise<number | null> {
  for (const p of ports) {
    let free = true;
    for (const host of ['127.0.0.1', '::1', '0.0.0.0', '::']) if (free) free = await portFree(p, host);
    if (free) return p;
  }
  return null;
}

/** Stop the process and everything it started. */
export function kill(proc: ChildProcess) {
  if (!proc.pid) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-proc.pid, 'SIGTERM');
  } catch (e) {
    log.warn('stopping a run failed', (e as Error).message);
    try { proc.kill(); } catch { /* already gone */ }
  }
}

export const runs = new Runs();
