// Publishes the installer of the current version as a GitHub release, which the app's update check then finds.
// usage: npm run dist:win && node scripts/release.mjs   (needs `gh` signed in to github.com)
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const files = fs.readdirSync('release').filter((f) => f.includes(`-${version}.`) && /\.(exe|dmg)$/.test(f)).map((f) => `release/${f}`);
if (!files.length) {
  console.error(`No installer for ${version} in release/. Build it first: npm run dist:win (or dist:mac).`);
  process.exit(1);
}
execFileSync('gh', ['release', 'create', `v${version}`, ...files, '--title', `v${version}`, '--generate-notes'], { stdio: 'inherit' });
