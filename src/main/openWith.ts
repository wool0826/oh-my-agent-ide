// Opens a Worker's folder in the editor, a terminal or the file manager (shared/openWith.ts has the rules).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shell } from 'electron';
import { EDITORS, cmdLine, editorLabel, editorLaunch, editorProgram, splitCommand, terminalLaunch, terminalsFor, type EditorId, type Found, type Launch } from '../shared/openWith';
import { findTool } from '../shared/toolpath';
import { loadSettings } from './settings';
import { fakeMode } from './fake';
import { e2eOpened } from './ipc/e2e';
import { log } from './log';

const isFile = (f: string) => { try { return fs.statSync(f).isFile(); } catch { return false; } };
const isDir = (f: string) => { try { return fs.statSync(f).isDirectory(); } catch { return false; } };

/** A program on the PATH: its full path, or null. Windows tries each PATHEXT ending (code → code.cmd). */
function which(name: string): string | null {
  if (path.isAbsolute(name)) return isFile(name) ? name : null;
  if (process.platform !== 'win32') return findTool(name, { platform: process.platform, path: process.env.PATH ?? '', exists: isFile });
  const exts = path.extname(name) ? [''] : (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  for (const dir of (process.env.PATH ?? '').split(';')) {
    const d = dir.trim().replace(/^"|"$/g, '');
    if (!d) continue;
    for (const e of exts) { const f = path.join(d, name + e.toLowerCase()); if (isFile(f)) return f; }
  }
  return null;
}

const macApp = (name: string) => process.platform === 'darwin'
  && [path.join('/Applications', `${name}.app`), path.join(os.homedir(), 'Applications', `${name}.app`)].some(isDir);

/** In e2e runs: only VS Code is "installed", so the menu and the missing-editor error are both reachable. */
const found = (): Found => fakeMode()
  ? { bin: (n) => n === 'code' || n === 'wt', macApp: () => false }
  : { bin: (n) => !!which(n), macApp };

/** Which editors this computer has, the custom command included; Settings and the open menu show it. */
export function editorsFound(): Record<EditorId, boolean> {
  const s = loadSettings();
  const out = { custom: !!splitCommand(s.editorCmd)[0] && found().bin(splitCommand(s.editorCmd)[0]) } as Record<EditorId, boolean>;
  for (const e of EDITORS) out[e.id] = !!editorLaunch(e.id, '', '.', process.platform, found());
  return out;
}

export type OpenWhat = 'editor' | EditorId | 'terminal' | 'reveal';
export type OpenResult = { ok: true } | { ok: false; why: 'gone' | 'missing' | 'failed'; name: string; prog: string; msg?: string };

function run(l: Launch): Promise<string | null> {
  if (fakeMode()) { e2eOpened.push(['open:with', [l.file, ...l.args].join(' ')]); return Promise.resolve(null); }
  return new Promise((resolve) => {
    const win = process.platform === 'win32';
    const full = which(l.file) ?? l.file;
    // A batch file (code.cmd) runs only through cmd.exe.
    const bat = win && /\.(cmd|bat)$/i.test(full);
    const [file, args] = bat ? ['cmd.exe', ['/d', '/s', '/c', cmdLine(full, l.args)]] : [full, l.args];
    try {
      const p = spawn(file, args, { cwd: l.cwd, detached: true, stdio: 'ignore', windowsHide: bat, windowsVerbatimArguments: bat });
      p.once('error', (e) => resolve(e.message));
      p.once('spawn', () => { p.unref(); resolve(null); });
    } catch (e) {
      resolve((e as Error).message);
    }
  });
}

/** Opens `folder` with `what` ('editor': the one chosen in Settings). */
export async function openWith(what: OpenWhat, folder: string): Promise<OpenResult> {
  const s = loadSettings();
  const editor: EditorId = what === 'editor' ? s.editor : what as EditorId;
  const isEditor = what !== 'terminal' && what !== 'reveal';
  const label = isEditor ? editorLabel(editor, s.editorCmd).name : '';
  const prog = isEditor ? editorProgram(editor, s.editorCmd) : '';
  if (!folder || !isDir(folder)) return { ok: false, why: 'gone', name: label, prog };
  if (what === 'reveal') {
    if (fakeMode()) { e2eOpened.push(['open:path', folder]); return { ok: true }; }
    const err = await shell.openPath(folder);
    return err ? { ok: false, why: 'failed', name: '', prog: '', msg: err } : { ok: true };
  }
  if (what === 'terminal') {
    const name = terminalsFor(process.platform).find((x) => x.id === s.terminal)?.name ?? '';
    const err = await run(terminalLaunch(s.terminal, folder, process.platform, found()));
    return err ? { ok: false, why: 'failed', name, prog: '', msg: err } : { ok: true };
  }
  const l = editorLaunch(editor, s.editorCmd, folder, process.platform, found());
  if (!l) { log.warn('open: no program for', editor, prog); return { ok: false, why: 'missing', name: label, prog }; }
  log.info('open: in', editor, folder);
  const err = await run(l);
  return err ? { ok: false, why: 'failed', name: label, prog, msg: err } : { ok: true };
}
