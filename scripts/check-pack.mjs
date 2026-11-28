// After `electron-builder --dir` (CI check job): the terminal's native parts are in the unpacked app, outside the
// asar, where node-pty and the PTY host (main/ptyHost.ts) load them, and the macOS helper can run.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = path.join(root, 'release');
const mac = process.platform === 'darwin';
const resources = mac
  ? fs.readdirSync(release).filter((d) => d.startsWith('mac')).map((d) => path.join(release, d, 'Oh My Agent IDE.app', 'Contents', 'Resources'))
  : fs.readdirSync(release).filter((d) => d.endsWith('-unpacked')).map((d) => path.join(release, d, 'resources'));
if (!resources.length) throw new Error(`no unpacked app in ${release}`);
const arch = process.arch;
let bad = 0;
for (const res of resources) {
  const unpacked = path.join(res, 'app.asar.unpacked');
  const pty = path.join(unpacked, 'node_modules', 'node-pty');
  const need = [path.join(unpacked, 'dist', 'ptyHost.cjs'), path.join(pty, 'lib', 'index.js'), path.join(pty, 'prebuilds', `${process.platform}-${arch}`, 'pty.node')];
  if (process.platform === 'win32') need.push(path.join(pty, 'prebuilds', `win32-${arch}`, 'conpty.node'), path.join(pty, 'lib', 'worker', 'conoutSocketWorker.js'));
  for (const f of need) if (!fs.existsSync(f)) { console.error(`missing: ${f}`); bad++; }
  if (mac) {
    const helper = path.join(pty, 'prebuilds', `darwin-${arch}`, 'spawn-helper');
    if (!fs.existsSync(helper) || !(fs.statSync(helper).mode & 0o111)) { console.error(`not executable: ${helper}`); bad++; }
  }
  const pdb = fs.readdirSync(pty, { recursive: true }).filter((f) => String(f).endsWith('.pdb'));
  if (pdb.length) { console.error(`debug symbols packed: ${pdb.join(', ')}`); bad++; }
  console.log(`${res}: ${bad ? 'not ok' : 'ok'}`);
}
process.exit(bad ? 1 : 0);
