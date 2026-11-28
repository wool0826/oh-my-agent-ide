// postinstall: node-pty 1.1.0 ships its macOS spawn-helper without the execute bit, and a shell then fails to start
// with "posix_spawnp failed" (in development and in the packaged app alike). Gives it back. Nothing to do on Windows.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pre = path.join(root, 'node_modules', 'node-pty', 'prebuilds');
if (process.platform !== 'win32' && fs.existsSync(pre)) {
  for (const dir of fs.readdirSync(pre)) {
    for (const f of [path.join(pre, dir, 'spawn-helper'), path.join(root, 'node_modules', 'node-pty', 'build', 'Release', 'spawn-helper')]) {
      if (fs.existsSync(f)) fs.chmodSync(f, 0o755);
    }
  }
}
