import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { store } from './store';
import { ghEnv } from './repos';
import { paths } from './paths';
import { kill } from './runs';
import { t } from './i18n';
import { log } from './log';
import { nowIso } from './util';
import { addOutput, handOver, lineCount, tailLines } from '../shared/shell';
import type { ChatItem, ShellRun } from '../shared/types';

/**
 * Lines the user runs from the chat with "!" (shared/shell.ts). They run as the user: in their own shell, in the IDE
 * home or a registered repository's checkout, with no Worker, slot or permission card. Each run is a chat item that
 * keeps the end of its output; when it ends, that end goes to the Dispatcher with its next turn (no turn of its own).
 */
/** PowerShell ends with 1 for any failed line; this hands back a native command's own exit code instead. */
export const psLine = (line: string) => `${line}\n$ok = $?; if ($ok) { exit 0 } elseif ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 }`;

class Shell {
  private procs = new Map<string, { proc: ChildProcess; out: string }>();
  private pushTimer: NodeJS.Timeout | null = null;

  /** Starts `cmd` in `repo` ('' or null for the IDE home). Returns the chat item's id. */
  run(cmd: string, repo: string | null): string {
    const line = cmd.trim();
    if (!line) throw new Error(t('shell.err.empty'));
    const r = repo ? store.repo(repo) : null;
    if (repo && !r) throw new Error(t('shell.err.noRepo', { name: repo }));
    const cwd = r ? r.path : paths().home;
    if (!fs.existsSync(cwd)) throw new Error(t('shell.err.noDir', { dir: cwd }));
    const run: ShellRun = { cmd: line, repo: r?.name ?? '', running: true, stopped: false, code: null, startedAt: nowIso(), ms: 0, out: '', lines: 0, sent: 'wait' };
    const item: ChatItem = store.chat('shell', line);
    item.shell = run;
    const win = process.platform === 'win32';
    const proc = spawn(win ? 'powershell.exe' : (process.env.SHELL || '/bin/sh'), win ? ['-NoProfile', '-NonInteractive', '-Command', psLine(line)] : ['-lc', line], {
      cwd, env: ghEnv(), windowsHide: true,
      // Its own process group, so Stop also stops what it started.
      detached: !win,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const entry = { proc, out: '' };
    // Line breaks seen in all: the count of lines, past what is kept.
    let breaks = 0;
    const count = () => breaks + (entry.out && !entry.out.endsWith('\n') ? 1 : 0);
    this.procs.set(item.id, entry);
    const keep = (d: Buffer) => {
      entry.out = addOutput(entry.out, d.toString());
      run.out = tailLines(entry.out);
      breaks += (d.toString().match(/\n/g) ?? []).length;
      run.lines = count();
      this.pushSoon();
    };
    proc.stdout?.on('data', keep);
    proc.stderr?.on('data', keep);
    const started = Date.now();
    let ended = false;
    const end = (code: number | null, note = '') => {
      if (ended) return;
      ended = true;
      this.procs.delete(item.id);
      if (note) entry.out = addOutput(entry.out, `${note}\n`);
      run.out = tailLines(entry.out);
      run.lines = Math.max(count(), lineCount(entry.out));
      run.running = false;
      run.code = run.stopped ? null : code;
      run.ms = Date.now() - started;
      if (run.stopped) run.sent = 'off';
      else {
        run.sent = 'queued';
        store.pushUpdate(handOver(run));
      }
      log.info(`shell run in ${cwd} ended`, run.code);
      store.changed();
    };
    proc.on('error', (e) => end(1, e.message));
    proc.on('close', (code) => end(code));
    log.info(`shell run in ${cwd}`, line);
    return item.id;
  }

  stop(id: string) {
    const e = this.procs.get(id);
    const item = store.data.chat.find((c) => c.id === id);
    if (!e || !item?.shell?.running) return;
    item.shell.stopped = true;
    kill(e.proc);
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
