import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { paths } from './paths';
import { ensureDir } from './util';
import { log } from './log';

const require_ = createRequire(import.meta.url);
let exe: string | undefined | null = null;

/**
 * The Claude Code binary used by the SDK. In development the SDK finds it;
 * in the packaged app we point to the copy unpacked outside the asar.
 */
export function claudeExecutable(): string | undefined {
  if (exe !== null) return exe;
  exe = undefined;
  try {
    const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
    const dir = path.dirname(require_.resolve(`${pkg}/package.json`));
    const bin = path.join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude');
    const unpacked = bin.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    if (app.isPackaged && fs.existsSync(unpacked)) exe = unpacked;
  } catch (e) {
    log.warn('claude binary lookup', (e as Error).message);
  }
  return exe;
}

/** Copy the bundled skill plugin into the IDE home and use it from there. */
export function installPlugin() {
  const src = app.isPackaged
    ? path.join(process.resourcesPath, 'plugin')
    : path.join(app.getAppPath(), 'resources', 'plugin');
  const dst = paths().plugin;
  if (!fs.existsSync(src)) {
    log.warn('plugin source missing', src);
    return;
  }
  ensureDir(dst);
  fs.cpSync(src, dst, { recursive: true, force: true });
}

export function pluginPath(): string | null {
  const p = paths().plugin;
  return fs.existsSync(path.join(p, '.claude-plugin', 'plugin.json')) ? p : null;
}
