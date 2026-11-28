// The side terminal as a real terminal (T-0165): the user's own shell in a pseudo terminal, kept running between
// lines. node-pty runs in the PTY host (main/ptyHost.ts), a utility process apart from the Dispatcher and the
// Workers; main/pty.ts starts it and holds the tabs; the window draws them with xterm.js. The rules both sides use.

/** A shell a tab can run: `id` is what the window asks for, never a path of its own. */
export interface PtyShell { id: string; name: string; file: string }

/** A tab as the window sees it. */
export interface PtyTab {
  id: string;
  /** The shell's id and short name ("pwsh", "zsh"). */
  shell: string;
  name: string;
  /** The registered repository it started in, or '' for the IDE home. */
  repo: string;
  /** The program in the foreground on macOS and Linux ("vim"), or '' (Windows, or the shell itself). */
  fg: string;
  live: boolean;
  /** The exit code once it ended; null while it runs, or when it was stopped or never started. */
  code: number | null;
  /** Why it could not start, when it could not. */
  error?: string;
  startedAt: string;
}

export interface PtyView {
  /** null until the PTY host was asked for; false when node-pty could not be loaded (the line mode stays). */
  available: boolean | null;
  reason?: string;
  tabs: PtyTab[];
}

export const PTY_EMPTY: PtyView = { available: null, tabs: [] };
/** Tabs at once. */
export const PTY_MAX_TABS = 8;
/** Lines each tab keeps above its screen (xterm.js). */
export const PTY_SCROLLBACK = 5000;
/** What main keeps of a tab's output, to draw it again after the window reloads. */
export const PTY_REPLAY = 256 * 1024;
/** The most the window sends in one write; a longer paste goes in pieces. */
export const PTY_WRITE_MAX = 64 * 1024;
/** Output is sent at most this often, or as soon as this much has come. */
export const PTY_BATCH_MS = 16;
export const PTY_BATCH_MAX = 64 * 1024;
/** The shell is paused while this much output is sent and not yet drawn, until it is back under PTY_LOW. */
export const PTY_HIGH = 512 * 1024;
export const PTY_LOW = 128 * 1024;
/** A stopped shell that is still there after a hang-up is ended for good this much later; sooner when the app quits. */
export const PTY_KILL_GRACE = 3000;
export const PTY_QUIT_GRACE = 300;

const base = (f: string) => (f.split(/[\\/]/).pop() ?? f).replace(/\.exe$/i, '');

/**
 * The shells a tab can run, the default first.
 * - Windows: PowerShell 7 when installed (`pwsh`), then Windows PowerShell, then the Command Prompt (%ComSpec%).
 * - macOS and Linux: the user's login shell ($SHELL), then the usual ones that are there.
 */
export function ptyShells(o: { platform: string; shell?: string; pwsh?: string | null; comspec?: string; exists: (file: string) => boolean }): PtyShell[] {
  const out: PtyShell[] = [];
  const add = (file: string, id = base(file)) => {
    if (!out.some((s) => s.id === id || s.file === file)) out.push({ id, name: base(file), file });
  };
  if (o.platform === 'win32') {
    if (o.pwsh) add(o.pwsh, 'pwsh');
    add('powershell.exe', 'powershell');
    add(o.comspec || 'cmd.exe', 'cmd');
    return out;
  }
  const own = o.shell && o.shell.startsWith('/') && o.exists(o.shell) ? o.shell : '';
  if (own) add(own);
  for (const f of ['/bin/zsh', '/bin/bash', '/opt/homebrew/bin/fish', '/usr/local/bin/fish', '/usr/bin/fish', '/bin/sh']) if (o.exists(f)) add(f);
  if (!out.length) add('/bin/sh');
  return out;
}

/**
 * How a shell starts: a login shell, interactive since it has a terminal, as a terminal app starts it. With the
 * profile off (Settings, as for "!" lines) it reads none of the user's start files.
 */
export function ptyArgs(sh: Pick<PtyShell, 'id' | 'name'>, profile: boolean): string[] {
  switch (sh.name.toLowerCase()) {
    case 'pwsh': case 'powershell': return profile ? ['-NoLogo'] : ['-NoLogo', '-NoProfile'];
    // /D skips the AutoRun commands in the registry, the Command Prompt's profile.
    case 'cmd': return profile ? [] : ['/D'];
    case 'zsh': return profile ? ['-l'] : ['-f'];
    case 'bash': return profile ? ['-l'] : ['--noprofile', '--norc'];
    case 'fish': return profile ? ['-l'] : ['--no-config'];
    default: return profile ? ['-l'] : [];
  }
}

/** Variables a session the app was started from leaves behind, which would confuse a `claude` run in the terminal. */
const DROP = /^(CLAUDECODE$|CLAUDE_CODE_ENTRYPOINT$|CLAUDE_CODE_SSE_PORT$|AI_AGENT$|MCP_CONNECTION|MCP_SERVER_CONNECTION|ELECTRON_RUN_AS_NODE$|ELECTRON_NO_ATTACH_CONSOLE$|OMA_)/;

/**
 * The shell's environment: the app's (with GH_HOST, main/repos.ts ghEnv) without what only the app needs, the
 * terminal's own names, and on macOS and Linux a UTF-8 locale when none is set (an app opened from the Finder has
 * none, and Korean would show as escapes).
 */
export function ptyEnv(env: Record<string, string | undefined>, o: { platform: string; version: string }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !DROP.test(k)) out[k] = v;
  out.TERM = 'xterm-256color';
  out.COLORTERM = 'truecolor';
  out.TERM_PROGRAM = 'OhMyAgentIDE';
  out.TERM_PROGRAM_VERSION = o.version;
  if (o.platform !== 'win32' && !out.LC_ALL && !out.LC_CTYPE && !out.LANG) out.LANG = 'en_US.UTF-8';
  return out;
}

/** A terminal's size as the PTY takes it: whole columns and rows in a sane range, 80 × 24 for nonsense. */
export function ptySize(cols: unknown, rows: unknown): { cols: number; rows: number } {
  const n = (v: unknown, lo: number, hi: number, d: number) => {
    const x = Math.floor(Number(v));
    return Number.isFinite(x) && x > 0 ? Math.min(hi, Math.max(lo, x)) : d;
  };
  return { cols: n(cols, 2, 500, 80), rows: n(rows, 1, 300, 24) };
}

/** What is typed or pasted, in pieces of at most `max` (PTY_WRITE_MAX), never between the two halves of an emoji. */
export function ptyChunks(d: string, max = PTY_WRITE_MAX): string[] {
  const out: string[] = [];
  for (let i = 0; i < d.length;) {
    let end = Math.min(d.length, i + max);
    const last = d.charCodeAt(end - 1);
    if (end < d.length && end - i > 1 && last >= 0xd800 && last <= 0xdbff) end--;
    out.push(d.slice(i, end));
    i = end;
  }
  return out;
}

/** The output kept to draw again (PTY_REPLAY): its end, from a line start so it does not begin inside a code. */
export function keepTail(kept: string, chunk: string, max = PTY_REPLAY): string {
  const all = kept + chunk;
  if (all.length <= max) return all;
  const cut = all.slice(-max);
  const nl = cut.indexOf('\n');
  return nl >= 0 && nl < cut.length - 1 ? cut.slice(nl + 1) : cut;
}

/** Output gathered into one message every PTY_BATCH_MS, or at once past PTY_BATCH_MAX. The timer is given. */
export class OutBatch {
  private buf = '';
  private timer: unknown = null;
  constructor(
    private send: (data: string) => void,
    private timers: { set: (fn: () => void, ms: number) => unknown; clear: (t: unknown) => void },
  ) {}

  push(data: string) {
    this.buf += data;
    if (this.buf.length >= PTY_BATCH_MAX) this.flush();
    else if (this.timer === null) this.timer = this.timers.set(() => { this.timer = null; this.flush(); }, PTY_BATCH_MS);
  }

  /** Sends what is gathered now (before the exit, say). */
  flush() {
    if (this.timer !== null) { this.timers.clear(this.timer); this.timer = null; }
    if (!this.buf) return;
    const b = this.buf;
    this.buf = '';
    this.send(b);
  }
}

/**
 * Flow control: output sent and not yet drawn. `sent` says when the shell should pause (past PTY_HIGH), `drawn`
 * when it may go on (back under PTY_LOW); each says so once.
 */
export class Flow {
  unacked = 0;
  paused = false;
  constructor(private high = PTY_HIGH, private low = PTY_LOW) {}

  sent(n: number): boolean {
    this.unacked += n;
    if (this.paused || this.unacked <= this.high) return false;
    this.paused = true;
    return true;
  }

  drawn(n: number): boolean {
    this.unacked = Math.max(0, this.unacked - Math.max(0, n));
    if (!this.paused || this.unacked > this.low) return false;
    this.paused = false;
    return true;
  }

  /** Nothing is waiting to be drawn any more (the window reloaded): go on. */
  reset(): boolean {
    this.unacked = 0;
    if (!this.paused) return false;
    this.paused = false;
    return true;
  }
}
