import { build, context } from 'esbuild';
import fs from 'node:fs';

const watch = process.argv.includes('--watch');
fs.mkdirSync('dist/renderer', { recursive: true });
for (const f of ['index.html', 'tokens.css', 'styles.css', 'quick.html']) fs.copyFileSync(`src/renderer/${f}`, `dist/renderer/${f}`);

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
  { ...common, entryPoints: ['src/renderer/app.ts'], outfile: 'dist/renderer/app.js', platform: 'browser', format: 'iife', target: 'chrome130' },
  { ...common, entryPoints: ['src/renderer/quick.ts'], outfile: 'dist/renderer/quick.js', platform: 'browser', format: 'iife', target: 'chrome130' },
];

if (watch) {
  for (const c of configs) await (await context(c)).watch();
} else {
  await Promise.all(configs.map((c) => build(c)));
}
