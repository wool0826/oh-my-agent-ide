import type { IPty } from 'node-pty';
import { Flow, OutBatch, PTY_KILL_GRACE } from '../shared/pty';

/**
 * The PTY host (T-0165): a utility process main/pty.ts starts, holding the side terminal's shells in pseudo terminals
 * with node-pty. A native crash or a stuck shell ends only this process, never the main one where the Dispatcher
 * and the Workers run. It is built on its own (dist/ptyHost.cjs) and kept out of the asar, beside node-pty.
 * It never logs what is typed or printed.
 */
export type HostIn =
  | { t: 'spawn'; id: string; file: string; args: string[]; cwd: string; env: Record<string, string>; cols: number; rows: number }
  | { t: 'write'; id: string; d: string }
  | { t: 'resize'; id: string; cols: number; rows: number }
  | { t: 'drawn'; id: string; n: number }
  | { t: 'reset'; id: string }
  | { t: 'kill'; id: string; grace?: number };

export type HostOut =
  | { t: 'ready' }
  | { t: 'unavailable'; reason: string }
  | { t: 'started'; id: string; pid: number }
  | { t: 'data'; id: string; d: string }
  | { t: 'fg'; id: string; name: string }
  | { t: 'exit'; id: string; code: number | null; error?: string };

interface Tab { pty: IPty; batch: OutBatch; flow: Flow; fg: string; ended: boolean }

const port = process.parentPort;
const post = (m: HostOut) => port.postMessage(m);
const tabs = new Map<string, Tab>();
const timers = { set: (fn: () => void, ms: number) => setTimeout(fn, ms), clear: (t: unknown) => clearTimeout(t as NodeJS.Timeout) };
const win = process.platform === 'win32';

function spawn(m: Extract<HostIn, { t: 'spawn' }>, pty: typeof import('node-pty')) {
  let p: IPty;
  try {
    p = pty.spawn(m.file, m.args, { name: 'xterm-256color', cols: m.cols, rows: m.rows, cwd: m.cwd, env: m.env, ...(win ? { useConpty: true } : {}) });
  } catch (e) {
    post({ t: 'exit', id: m.id, code: null, error: (e as Error).message });
    return;
  }
  const tab: Tab = { pty: p, batch: new OutBatch((d) => post({ t: 'data', id: m.id, d }), timers), flow: new Flow(), fg: '', ended: false };
  tabs.set(m.id, tab);
  post({ t: 'started', id: m.id, pid: p.pid });
  p.onData((d) => {
    tab.batch.push(d);
    if (tab.flow.sent(d.length)) p.pause();
  });
  p.onExit(({ exitCode }) => {
    tab.ended = true;
    tab.batch.flush();
    tabs.delete(m.id);
    post({ t: 'exit', id: m.id, code: exitCode });
  });
  // The program in the foreground ("vim", or the shell again) names the tab. Only Unix tells it; on Windows it is
  // always the shell.
  if (win) return;
  const poll = setInterval(() => {
    if (tab.ended) { clearInterval(poll); return; }
    let name = '';
    try { name = p.process; } catch { /* gone */ }
    if (name && name !== tab.fg) { tab.fg = name; post({ t: 'fg', id: m.id, name }); }
  }, 1000);
  poll.unref();
}

/**
 * Stop: a hang-up, as when a terminal window closes, then for good if the shell is still there `grace` ms later
 * (PTY_KILL_GRACE, or PTY_QUIT_GRACE when the app quits and this process goes soon after).
 */
function kill(id: string, grace = PTY_KILL_GRACE) {
  const tab = tabs.get(id);
  if (!tab || tab.ended) return;
  // On Windows node-pty ends every process on the pseudo console with it.
  if (win) { try { tab.pty.kill(); } catch { /* gone */ } return; }
  try { tab.pty.kill('SIGHUP'); } catch { /* gone */ }
  setTimeout(() => {
    if (tab.ended) return;
    try { process.kill(-tab.pty.pid, 'SIGKILL'); } catch { try { tab.pty.kill('SIGKILL'); } catch { /* gone */ } }
  }, grace).unref();
}

async function main() {
  let pty: typeof import('node-pty');
  try {
    pty = await import('node-pty');
  } catch (e) {
    post({ t: 'unavailable', reason: (e as Error).message });
    return;
  }
  port.on('message', (e: { data: HostIn }) => {
    const m = e.data;
    if (m.t === 'spawn') { spawn(m, pty); return; }
    const tab = tabs.get(m.id);
    if (!tab || tab.ended) return;
    try {
      if (m.t === 'write') tab.pty.write(m.d);
      else if (m.t === 'resize') tab.pty.resize(m.cols, m.rows);
      else if (m.t === 'drawn') { if (tab.flow.drawn(m.n)) tab.pty.resume(); }
      else if (m.t === 'reset') { if (tab.flow.reset()) tab.pty.resume(); }
      else if (m.t === 'kill') kill(m.id, m.grace);
    } catch { /* the shell ended in between: its exit comes */ }
  });
  post({ t: 'ready' });
}

void main();
