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
 * SDK가 쓰는 Claude Code 실행 파일. 개발 중에는 SDK가 알아서 찾게 두고,
 * 패키징된 앱에서는 asar 밖으로 풀린 경로를 직접 알려 준다.
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

/** 앱에 들어 있는 기본 스킬 플러그인을 IDE 홈으로 복사해 두고 그 경로를 쓴다. */
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
