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
const tag = `v${version}`;
// Listed, not looked up by tag: the API's tag lookup does not return drafts. A second machine (the dmg after the exe)
// adds its file to the draft the first one made.
const known = execFileSync('gh', ['release', 'list', '--limit', '100', '--json', 'tagName', '--jq', '.[].tagName'], { encoding: 'utf8' });
if (known.split(/\r?\n/).includes(tag)) execFileSync('gh', ['release', 'upload', tag, ...files, '--clobber'], { stdio: 'inherit' });
else execFileSync('gh', ['release', 'create', tag, ...files, '--title', tag, '--generate-notes', '--draft', '--verify-tag'], { stdio: 'inherit' });
