// Runs one shard of the end-to-end flows: `node test/e2e/shard.mjs 2/3`. Every test/e2e/*.e2e.mjs file is weighed by
// its number of flows and dealt, largest first, to the lightest shard, so the shards take about as long and a new
// file joins one without a change to CI. The screen comparison (visual.e2e.mjs) has a job of its own and is left out.
// Needs the built app (`npm run build`). `--list` prints the shards only.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const m = /^(\d+)\/(\d+)$/.exec(process.argv[2] ?? '');
if (!m || +m[1] < 1 || +m[1] > +m[2]) {
  console.error('Usage: node test/e2e/shard.mjs <shard>/<total> [--list]');
  process.exit(2);
}
const [index, total] = [+m[1], +m[2]];

const files = fs.readdirSync(here).filter((f) => f.endsWith('.e2e.mjs') && f !== 'visual.e2e.mjs')
  .map((f) => ({ f, flows: (fs.readFileSync(path.join(here, f), 'utf8').match(/^\s*flow\(/gm) ?? []).length }))
  .sort((a, b) => b.flows - a.flows || a.f.localeCompare(b.f));
const shards = Array.from({ length: total }, () => ({ flows: 0, files: [] }));
for (const x of files) {
  const s = shards.reduce((low, s) => (s.flows < low.flows ? s : low));
  s.flows += x.flows;
  s.files.push(x.f);
}

if (process.argv.includes('--list')) {
  shards.forEach((s, i) => console.log(`${i + 1}/${total}: ${s.flows} flows in ${s.files.join(', ')}`));
  process.exit(0);
}
const mine = shards[index - 1];
console.log(`Shard ${index}/${total}: ${mine.flows} flows in ${mine.files.join(', ')}`);
if (!mine.files.length) process.exit(0);
const run = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...mine.files.map((f) => path.join(here, f))], { stdio: 'inherit' });
process.exit(run.status ?? 1);
