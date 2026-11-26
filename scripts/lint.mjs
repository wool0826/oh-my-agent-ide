// `npm run lint`: ESLint over src and test with the config in eslint.config.mjs. The tools are in tools/lint, apart
// from the app's packages (see its package.json for why); they are installed there first when missing or out of date.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tools = path.join(root, 'tools', 'lint');
const lock = path.join(tools, 'package-lock.json');
const installed = path.join(tools, 'node_modules', '.package-lock.json');
const stale = !fs.existsSync(installed) || fs.statSync(installed).mtimeMs < fs.statSync(lock).mtimeMs;
if (stale) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  execFileSync(npm, ['ci', '--prefix', tools, '--no-audit', '--no-fund', '--loglevel=error'], { stdio: 'inherit', shell: process.platform === 'win32' });
}
const eslint = path.join(tools, 'node_modules', 'eslint', 'bin', 'eslint.js');
const r = spawnSync(process.execPath, [eslint, '--max-warnings=0', ...(process.argv.length > 2 ? process.argv.slice(2) : ['.'])], { cwd: root, stdio: 'inherit' });
process.exit(r.status ?? 1);
