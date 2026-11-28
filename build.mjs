import { build, context } from 'esbuild';
import fs from 'node:fs';

const watch = process.argv.includes('--watch');
fs.mkdirSync('dist/renderer', { recursive: true });
for (const f of ['index.html', 'tokens.css', 'styles.css', 'quick.html']) fs.copyFileSync(`src/renderer/${f}`, `dist/renderer/${f}`);
// xterm.js's own sheet, as it ships: kept out of src/renderer, where every sheet is checked for tokens (cssTokens.test).
fs.copyFileSync('node_modules/@xterm/xterm/css/xterm.css', 'dist/renderer/xterm.css');

const common = { bundle: true, sourcemap: true, logLevel: 'info' };
const configs = [
  {
    ...common,
    entryPoints: ['src/main/index.ts'],
    outfile: 'dist/main.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['electron', '@anthropic-ai/claude-agent-sdk', 'zod', 'electron-updater'],
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  },
  { ...common, entryPoints: ['src/preload/index.ts'], outfile: 'dist/preload.cjs', platform: 'node', format: 'cjs', external: ['electron'] },
  // The terminal's PTY host (main/ptyHost.ts), a utility process of its own; node-pty is loaded from node_modules.
  { ...common, entryPoints: ['src/main/ptyHost.ts'], outfile: 'dist/ptyHost.cjs', platform: 'node', format: 'cjs', target: 'node22', external: ['electron', 'node-pty'] },
  { ...common, entryPoints: ['src/renderer/app.ts'], outfile: 'dist/renderer/app.js', platform: 'browser', format: 'iife', target: 'chrome130' },
  { ...common, entryPoints: ['src/renderer/quick.ts'], outfile: 'dist/renderer/quick.js', platform: 'browser', format: 'iife', target: 'chrome130' },
];

if (watch) {
  for (const c of configs) await (await context(c)).watch();
} else {
  await Promise.all(configs.map((c) => build(c)));
}
