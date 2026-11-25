// Local fallback for .github/workflows/release.yml (docs/RELEASING.md): attaches the installers of the current version
// in release/ to a draft GitHub release for the pushed tag v<version>. Publish the draft on GitHub after checking it.
// usage: npm run dist:win && node scripts/release.mjs   (needs `gh` signed in to github.com)
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const files = fs.readdirSync('release').filter((f) => (f.includes(`-${version}.`) || f.includes(`-${version}-`)) && /\.(exe|dmg)$/.test(f)).map((f) => `release/${f}`);
if (!files.length) {
  console.error(`No installer for ${version} in release/. Build it first: npm run dist:win (or dist:mac).`);
  process.exit(1);
}
execFileSync('gh', ['release', 'create', `v${version}`, ...files, '--title', `v${version}`, '--generate-notes', '--draft', '--verify-tag'], { stdio: 'inherit' });
