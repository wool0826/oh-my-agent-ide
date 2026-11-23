import { spawn, type ChildProcess } from 'node:child_process';
import { store } from './store';
import { ghEnv } from './repos';
import { t } from './i18n';
import { log } from './log';
import { nowIso } from './util';
import { appendOutput, localUrl } from '../shared/runOutput';
import type { RunView } from '../shared/types';

/**
 * A repository's run command (a dev server, the app itself) started in a Worker's worktree, so the user can try the
 * Worker's change. One run per Worker. It belongs to this session of the app: nothing is stored (the window is told
 * without a save of the state), and quitting stops it.
 */
class Runs {
  private procs = new Map<string, { proc: ChildProcess; view: RunView; out: string }>();
  private pushTimer: NodeJS.Timeout | null = null;

  views(): RunView[] {
    return [...this.procs.values()].map((r) => r.view);
  }

  start(workerId: string) {
    const w = store.worker(workerId);
    const repo = w?.repo ? store.repo(w.repo) : null;
    const cmd = repo?.run?.trim();
    if (!w || !repo || !cmd) throw new Error(t('run.err.none'));
    if (this.procs.get(workerId)?.view.running) return;
    const win = process.platform === 'win32';
    const proc = spawn(win ? 'powershell.exe' : (process.env.SHELL || '/bin/sh'), win ? ['-NoProfile', '-NonInteractive', '-Command', cmd] : ['-lc', cmd], {
      cwd: w.cwd, env: { ...ghEnv(), ROOT_PATH: repo.path, OMA_ROOT_PATH: repo.path }, windowsHide: true,
      // Its own process group, so stopping it also stops what it started (a dev server behind npm).
      detached: !win,
    });
    const entry = { proc, out: '', view: { workerId, running: true, code: null, tail: '', url: null, startedAt: nowIso() } as RunView };
    this.procs.set(workerId, entry);
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
