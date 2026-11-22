// Gives every child process the user's real PATH (shared/toolpath.ts). Run once at boot, before anything spawns a tool.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { augmentedPath, findTool, parseShellPath, PATH_MARKER } from '../shared/toolpath';
import { log } from './log';

/** The PATH the user's login shell prints, or null when there is no shell, it fails or it takes longer than `timeoutMs`. */
export function loginShellPath(shell: string | undefined, timeoutMs = 3_000): Promise<string | null> {
  if (!shell) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      execFile(shell, ['-ilc', `printf '%s' "${PATH_MARKER}$PATH"`], { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        resolve(err && !stdout ? null : parseShellPath(String(stdout ?? '')));
      });
    } catch {
      resolve(null);
    }
  });
}

/** Widens process.env.PATH on macOS and Linux; spawns and run() inherit it. Windows is left as it is. */
export async function fixToolPath(): Promise<void> {
  if (process.platform === 'win32') return;
  const before = process.env.PATH;
  const shellPath = await loginShellPath(process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh'));
  process.env.PATH = augmentedPath({ platform: process.platform, current: before, shellPath, home: os.homedir() });
  if (process.env.PATH !== before) log.info('tool PATH', process.env.PATH);
}

const resolved = new Map<string, string>();
const isFile = (f: string) => { try { return fs.statSync(f).isFile(); } catch { return false; } };

/**
 * The program to spawn for `name`: its absolute path on macOS and Linux when one is found, `name` otherwise.
 * Found paths are kept; a miss is looked up again next time, so a tool installed while the app runs is found.
 */
export function toolCommand(name: string): string {
  const hit = resolved.get(name);
  if (hit && isFile(hit)) return hit;
  const found = findTool(name, { platform: process.platform, path: process.env.PATH ?? '', exists: isFile });
  if (!found) return name;
  resolved.set(name, found);
  return found;
}
