import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { store } from './store';
import { ghEnv } from './repos';
import { paths } from './paths';
import { kill } from './runs';
import { t } from './i18n';
import { log } from './log';
import { nowIso } from './util';
import { loadSettings } from './settings';
import { addOutput, dropRcNoise, errRows, handOver, lineCount, markErr, shellArgs, SHELL_KEEP, tailLines } from '../shared/shell';
import type { ChatItem, ShellRun } from '../shared/types';

/**
 * Lines the user runs from the chat with "!" (shared/shell.ts). They run as the user: in their own shell, in the IDE
 * home or a registered repository's checkout, with no Worker, slot or permission card. Each run is a chat item that
 * keeps the end of its output; when it ends, that end goes to the Dispatcher with its next turn (no turn of its own).
 * The side terminal (main/terminal.ts) runs its lines the same way, kept apart from the chat.
 */
/** PowerShell 7 on Windows, when it is installed: on the PATH or in its usual folder. Looked up each time (cheap). */
function findPwsh(): string | null {
  const dirs = [...(process.env.PATH ?? '').split(';'), path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7')];
  for (const d of dirs) {
    if (!d.trim()) continue;
    const f = path.join(d.trim(), 'pwsh.exe');
    try { if (fs.statSync(f).isFile()) return f; } catch { /* not here */ }
  }
  return null;
}

/** Where a line runs: a registered repository's checkout, or the IDE home ('' or null). Throws when it can't. */
export function shellCwd(repo: string | null): { cwd: string; repo: string } {
  const r = repo ? store.repo(repo) : null;
  if (repo && !r) throw new Error(t('shell.err.noRepo', { name: repo }));
  const cwd = r ? r.path : paths().home;
  if (!fs.existsSync(cwd)) throw new Error(t('shell.err.noDir', { dir: cwd }));
  return { cwd, repo: r?.name ?? '' };
}

/** A line on its way: Stop ends it and what it started. */
export interface Running { stop(): void }

/**
 * Runs `run.cmd` in `cwd` and keeps the end of its output on `run` as it comes (`output`), then its exit code and
 * time (`ended`, once).
 */
export function startLine(run: ShellRun, cwd: string, output: () => void, ended: () => void): Running {
  const win = process.platform === 'win32';
  const profile = loadSettings().shellProfile !== false;
  const how = shellArgs({ platform: process.platform, shell: process.env.SHELL || '/bin/sh', cmd: run.cmd, profile, pwsh: win && profile ? findPwsh() : null });
  const proc: ChildProcess = spawn(how.file, how.args, {
    cwd, env: ghEnv(), windowsHide: true,
    // Its own process group, so Stop also stops what it started.
    detached: !win,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  // Line breaks seen in all: the count of lines, past what is kept.
  let breaks = 0;
  const count = () => breaks + (out && !out.endsWith('\n') ? 1 : 0);
  // stderr lines by their number over all the output; the run keeps where they are in its kept end (G2).
  let errAbs: number[] = [];
  const syncErr = () => {
    if (!errAbs.length) return;
    // The kept end drops the line breaks it ends with: its last line is the one before them.
    const lastAbs = breaks - (/\n*$/.exec(out)?.[0].length ?? 0);
    const rows = errRows(errAbs, lastAbs, lineCount(run.out));
    if (rows.length) run.err = rows; else delete run.err;
  };
  const keep = (text: string, err = false) => {
    if (!text) return;
    // The line this chunk starts on (the one being written, or the next).
    const from = breaks;
    out = addOutput(out, text);
    run.out = tailLines(out);
    // Counted as kept: without terminal codes, with "\r\n" and "\r" as one break.
    breaks += (addOutput('', text, Infinity).match(/\n/g) ?? []).length;
    run.lines = count();
    if (err) {
      const to = out.endsWith('\n') ? breaks - 1 : breaks;
      if (to >= from) errAbs = markErr(errAbs, from, to, Math.max(0, breaks - SHELL_KEEP - 1));
    }
    syncErr();
    output();
  };
  // One decoder for each stream, so a character split between chunks stays whole.
  // A marked run's output starts with what the rc files print; each pipe drops it up to its own RC_DONE.
  for (const [stream, err] of [[proc.stdout, false], [proc.stderr, true]] as const) {
    const dec = new StringDecoder('utf8');
    let rc: string | null = how.marked ? '' : null;
    const take = (text: string, last = false) => {
      const r = dropRcNoise(rc, text, last);
      rc = r.pending;
      keep(r.show, err);
    };
    stream?.on('data', (d: Buffer) => take(dec.write(d)));
    stream?.on('end', () => take(dec.end(), true));
  }
  const started = Date.now();
  let done = false;
  const end = (code: number | null, note = '') => {
    if (done) return;
    done = true;
    if (note) {
      out = addOutput(out, `${note}\n`);
      // Counted like any other output, so the stderr lines before it keep their place.
      breaks += (addOutput('', `${note}\n`, Infinity).match(/\n/g) ?? []).length;
    }
    run.out = tailLines(out);
    run.lines = Math.max(count(), lineCount(out));
    syncErr();
    // Why it could not start is an error line too: the last one.
    if (note) run.err = [...new Set([...(run.err ?? []), lineCount(run.out) - 1])];
    run.running = false;
    run.code = run.stopped ? null : code;
    run.ms = Date.now() - started;
    log.info(`shell run in ${cwd} ended`, run.code);
    ended();
  };
  proc.on('error', (e) => end(1, e.message));
  proc.on('close', (code) => end(code));
  log.info(`shell run in ${cwd} (${how.file}${profile ? ', profile' : ''})`, run.cmd);
  return {
    stop() {
      if (done) return;
      run.stopped = true;
      kill(proc);
      // A command that ignores the stop signal is ended for good a little later.
      if (!win) {
        setTimeout(() => {
          if (!done && proc.pid) try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* gone */ }
        }, 3000).unref();
      }
    },
  };
}

/** A new run of `line` as it starts. */
export const newRun = (line: string, repo: string): ShellRun => ({ cmd: line, repo, running: true, stopped: false, code: null, startedAt: nowIso(), ms: 0, out: '', lines: 0, sent: 'wait' });

class Shell {
  private procs = new Map<string, Running>();
  private pushTimer: NodeJS.Timeout | null = null;

  /**
   * Starts `cmd` in `repo` ('' or null for the IDE home). Returns the chat item's id.
   * `ask`: when it ends, the Dispatcher takes a turn for the result (store 'shell-done'). Only the user's own runs
   * pass it, and the Dispatcher has no way to start one, so a run can never lead to another by itself.
   */
  run(cmd: string, repo: string | null, opts: { script?: string; ask?: boolean } = {}): string {
    const { script, ask } = opts;
    const line = cmd.trim();
    if (!line) throw new Error(t('shell.err.empty'));
    const where = shellCwd(repo);
    const run: ShellRun = { ...newRun(line, where.repo), ...(script ? { script } : {}), ...(ask ? { ask } : {}) };
    const item: ChatItem = store.chat('shell', line);
    item.shell = run;
    this.procs.set(item.id, startLine(run, where.cwd, () => this.pushSoon(), () => {
      this.procs.delete(item.id);
      if (run.stopped) run.sent = 'off';
      else {
        run.sent = 'queued';
        store.pushUpdate(handOver(run));
      }
      store.changed();
      if (run.ask && !run.stopped) store.emit('shell-done');
    }));
    return item.id;
  }

  stop(id: string) {
    const e = this.procs.get(id);
    const item = store.data.chat.find((c) => c.id === id);
    if (!e || !item?.shell?.running) return;
    e.stop();
    store.changed();
  }

  stopAll() {
    for (const [id] of this.procs) this.stop(id);
  }

  /** Runs that were going when the app last quit (or crashed) are over: shown as stopped, not sent. */
  settle() {
    let any = false;
    for (const c of store.data.chat) {
      if (c.shell?.running) {
        Object.assign(c.shell, { running: false, stopped: true, sent: c.shell.sent === 'wait' ? 'off' : c.shell.sent });
        any = true;
      }
    }
    if (any) store.changed();
  }

  /** Output arrives in bursts; the window gets it at most a few times a second, without a save. */
  private pushSoon() {
    if (this.pushTimer) return;
    this.pushTimer = setTimeout(() => { this.pushTimer = null; store.emit('changed'); }, 250);
  }
}

export const shell = new Shell();
