import { app, utilityProcess, type UtilityProcess } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { findPwsh, shellCwd } from './shell';
import { ghEnv } from './repos';
import { loadSettings } from './settings';
import { t } from './i18n';
import { log } from './log';
import { nowIso, uid } from './util';
import { keepTail, PTY_EMPTY, PTY_MAX_TABS, PTY_QUIT_GRACE, ptyArgs, ptyChunks, ptyEnv, ptyGone, ptyShells, ptySize, type PtyShell, type PtyTab, type PtyView } from '../shared/pty';
import type { HostIn, HostOut } from './ptyHost';

interface Tab extends PtyTab {
  /** The end of its output, drawn again when the window reloads (PTY_REPLAY). */
  replay: string;
  /** Characters of output so far: each piece the window gets says where it ends, so a replay is not drawn twice. */
  total: number;
  /** Stopped from the app (kill or close), not ended by itself. */
  stopped?: boolean;
}

const isFile = (f: string) => { try { return fs.statSync(f).isFile(); } catch { return false; } };

/**
 * The side terminal's shells (shared/pty.ts): each tab a shell of the user's in a pseudo terminal, held by the PTY
 * host (main/ptyHost.ts) and started the first time a tab opens. Main checks what the window asks for: the folder is
 * the IDE home or a registered repository (shellCwd), the shell one of ptyShells by its id. Nothing typed or printed
 * is logged, kept on disk or given to the Dispatcher. With OMA_PTY=0, or when node-pty cannot be loaded, there is no
 * tab and the terminal keeps its line mode (main/terminal.ts).
 */
class Ptys {
  private host: UtilityProcess | null = null;
  private ready: Promise<boolean> | null = null;
  private view: PtyView = { ...PTY_EMPTY };
  private tabs: Tab[] = [];
  private stateFns: ((v: PtyView) => void)[] = [];
  private dataFns: ((id: string, d: string, end: number) => void)[] = [];
  private here = '';
  private quitting = false;

  /** `here`: the folder of the built main script, where ptyHost.cjs is. */
  init(here: string) {
    this.here = here;
    // Turned off: the window knows from the start, and shows the line mode.
    if (process.env.OMA_PTY === '0') this.view = { ...this.view, available: false };
  }
  onChange(fn: (v: PtyView) => void) { this.stateFns.push(fn); }
  onData(fn: (id: string, d: string, end: number) => void) { this.dataFns.push(fn); }
  state(): PtyView { return this.view; }

  shells(): PtyShell[] {
    const win = process.platform === 'win32';
    return ptyShells({ platform: process.platform, shell: process.env.SHELL, pwsh: win ? findPwsh() : null, comspec: process.env.ComSpec, exists: isFile });
  }

  /** Opens a tab: `shell` by its id (the default when none), in `repo` ('' or null for the IDE home). */
  async open(o: { shell?: string | null; repo?: string | null; cols?: unknown; rows?: unknown } = {}): Promise<PtyTab> {
    if (this.tabs.length >= PTY_MAX_TABS) throw new Error(t('term.err.tooMany', { n: PTY_MAX_TABS }));
    const where = shellCwd(o.repo || null);
    const shells = this.shells();
    const sh = o.shell ? shells.find((s) => s.id === o.shell) : shells[0];
    if (!sh) throw new Error(t('term.err.noShell', { name: String(o.shell) }));
    if (!(await this.start()) || !this.host) throw new Error(t('term.err.ptyOff'));
    // Again: other tabs may have opened while the host started.
    if (this.tabs.length >= PTY_MAX_TABS) throw new Error(t('term.err.tooMany', { n: PTY_MAX_TABS }));
    const tab: Tab = { id: uid(), shell: sh.id, name: sh.name, repo: where.repo, fg: '', live: true, code: null, startedAt: nowIso(), replay: '', total: 0 };
    this.tabs.push(tab);
    this.spawn(tab, sh, where.cwd, o);
    return this.copy(tab);
  }

  /**
   * Starts an ended tab's shell again in the same tab: its shell, in its folder, at the size given. What it printed
   * before is not drawn again; the count of its output goes on, so a piece the window has is still known.
   */
  async restart(o: { id?: unknown; cols?: unknown; rows?: unknown } = {}): Promise<PtyTab> {
    const tab = this.tabs.find((x) => x.id === o.id);
    if (!tab) throw new Error(t('term.err.noTab'));
    if (tab.live) return this.copy(tab);
    const where = shellCwd(tab.repo || null);
    const sh = this.shells().find((s) => s.id === tab.shell);
    if (!sh) throw new Error(t('term.err.noShell', { name: tab.name }));
    if (!(await this.start()) || !this.host) throw new Error(t('term.err.ptyOff'));
    // Again: it may have been started or closed while the host started.
    if (tab.live || !this.tabs.includes(tab)) return this.copy(tab);
    delete tab.error;
    delete tab.stopped;
    Object.assign(tab, { live: true, code: null, fg: '', startedAt: nowIso(), replay: '' });
    this.spawn(tab, sh, where.cwd, o);
    return this.copy(tab);
  }

  /** Keys typed or pasted. A longer piece than PTY_WRITE_MAX goes in several. */
  write(id: string, d: unknown) {
    const tab = this.live(id);
    if (!tab || typeof d !== 'string' || !d) return;
    for (const piece of ptyChunks(d)) this.send({ t: 'write', id, d: piece });
  }

  resize(id: string, cols: unknown, rows: unknown) {
    if (this.live(id)) this.send({ t: 'resize', id, ...ptySize(cols, rows) });
  }

  /** The window drew `n` characters of a tab's output (flow control). */
  drawn(id: string, n: unknown) {
    const k = Math.floor(Number(n));
    if (this.live(id) && Number.isFinite(k) && k > 0) this.send({ t: 'drawn', id, n: k });
  }

  /** The window (again) draws a tab: the end of its output so far, and where that ends. Nothing is waiting on it now. */
  attach(id: string): { replay: string; end: number } {
    const tab = this.tabs.find((x) => x.id === id);
    if (!tab) throw new Error(t('term.err.noTab'));
    if (tab.live) this.send({ t: 'reset', id });
    return { replay: tab.replay, end: tab.total };
  }

  /** Stops a tab's shell; the tab stays, showing that it ended. */
  kill(id: string) {
    const tab = this.live(id);
    if (!tab) return;
    tab.stopped = true;
    this.send({ t: 'kill', id });
  }

  /** Stops a tab's shell if it still runs, and takes the tab away. */
  close(id: string) {
    this.kill(id);
    this.tabs = this.tabs.filter((x) => x.id !== id);
    this.emit();
  }

  /** The app quits: every shell is stopped, for good soon (before the host goes), then the host. */
  stopAll() {
    this.quitting = true;
    for (const tab of this.tabs) if (tab.live) this.send({ t: 'kill', id: tab.id, grace: PTY_QUIT_GRACE });
    const host = this.host;
    if (host) setTimeout(() => host.kill(), 500).unref();
  }

  private spawn(tab: Tab, sh: PtyShell, cwd: string, o: { cols?: unknown; rows?: unknown }) {
    const size = ptySize(o.cols, o.rows);
    const profile = loadSettings().shellProfile !== false;
    const env = ptyEnv(ghEnv(), { platform: process.platform, version: app.getVersion() });
    this.send({ t: 'spawn', id: tab.id, file: sh.file, args: ptyArgs(sh, profile), cwd, env, ...size });
    log.info(`pty ${tab.id}: ${sh.file} in ${cwd}, ${size.cols}x${size.rows}${profile ? ', profile' : ''}`);
    this.emit();
  }

  private live(id: string): Tab | undefined {
    const tab = this.tabs.find((x) => x.id === id);
    return tab?.live ? tab : undefined;
  }

  private send(m: HostIn) { this.host?.postMessage(m); }

  /** The host, started once; false when node-pty could not be loaded (then for good) or the host did not start. */
  private start(): Promise<boolean> {
    if (this.ready) return this.ready;
    // Turned off on purpose: the line mode, with no warning (that is for node-pty not loading).
    if (process.env.OMA_PTY === '0') return (this.ready = Promise.resolve(this.setAvailable(false)));
    // Kept out of the asar beside node-pty (package.json asarUnpack), so its worker and helper run from real files.
    const file = path.join(this.here, 'ptyHost.cjs').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    const host = utilityProcess.fork(file, [], { serviceName: 'Oh My Agent IDE terminal', stdio: 'ignore' });
    this.host = host;
    this.ready = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { log.warn('pty host: no answer'); host.kill(); }, 20_000);
      host.on('message', (m: HostOut) => {
        if (m.t === 'ready') { clearTimeout(timer); resolve(this.setAvailable(true)); return; }
        if (m.t === 'unavailable') {
          clearTimeout(timer);
          log.warn('pty host: node-pty not available', m.reason);
          resolve(this.setAvailable(false, m.reason));
          host.kill();
          return;
        }
        this.fromHost(m);
      });
      host.on('exit', (code) => {
        clearTimeout(timer);
        resolve(false);
        this.gone(host, code);
      });
    });
    return this.ready;
  }

  private setAvailable(on: boolean, reason = ''): boolean {
    this.view = { ...this.view, available: on, ...(reason ? { reason } : {}) };
    if (on) delete this.view.reason;
    this.emit();
    return on;
  }

  /** The host ended: its tabs ended with it. It starts again for the next tab, unless node-pty could not be loaded. */
  private gone(host: UtilityProcess, code: number) {
    if (this.host !== host) return;
    this.host = null;
    if (this.quitting) return;
    log.warn('pty host exited', code);
    if (this.view.available !== false) this.ready = null;
    for (const tab of this.tabs) if (tab.live) Object.assign(tab, { live: false, code: null, error: t('term.err.host') });
    this.emit();
  }

  private fromHost(m: HostOut) {
    if (m.t === 'ready' || m.t === 'unavailable') return;
    const tab = this.tabs.find((x) => x.id === m.id);
    if (!tab) return;
    if (m.t === 'data') {
      tab.replay = keepTail(tab.replay, m.d);
      tab.total += m.d.length;
      for (const fn of this.dataFns) fn(tab.id, m.d, tab.total);
    } else if (m.t === 'fg') {
      tab.fg = m.name === tab.name ? '' : m.name;
      this.emit();
    } else if (m.t === 'exit') {
      Object.assign(tab, { live: false, code: m.code, ...(m.error ? { error: m.error } : {}) });
      log.info(`pty ${tab.id} ended`, m.code, m.error ?? '');
      if (ptyGone({ code: m.code, error: m.error, stopped: !!tab.stopped })) this.tabs = this.tabs.filter((x) => x !== tab);
      this.emit();
    }
  }

  private copy(tab: Tab): PtyTab {
    const { replay: _r, total: _t, ...rest } = tab;
    return { ...rest };
  }

  private emit() {
    if (this.quitting) return;
    this.view = { ...this.view, tabs: this.tabs.map((x) => this.copy(x)) };
    for (const fn of this.stateFns) fn(this.view);
  }
}

export const ptys = new Ptys();
