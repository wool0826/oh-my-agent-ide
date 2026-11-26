import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanDecisionFiles, memoryDigest, remember, searchMemory } from '../src/main/memory';
import { month } from '../src/main/util';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-memclean-'));
process.env.OMA_DATA_DIR = tmp;
const home = path.join(tmp, 'home');
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ home, language: 'en', accounts: [] }));
const decisions = path.join(home, 'memory', 'decisions');
const backups = path.join(home, 'data', 'backups');

const SAVED = [
  '# Decisions 2026-11',
  '',
  '- W-06: Run this command? → Allow _(2026-11-24)_',
  '- W-06: Run this command? → Allow _(2026-11-24)_',
  '- W-12, W-16, W-22: Allow recall? → Allow _(2026-11-21)_',
  '- W-20: Review the plan → Approve plan _(2026-11-26)_',
  '- Dispatcher: Push the v0.7.0 tag? → hold: test it first _(2026-11-26)_',
  '- Dispatcher: Push the v0.7.0 tag? → hold: test it first _(2026-11-26)_',
  '',
].join('\n');

test('memory: clean-up at launch copies each file it changes to data/backups first, then takes the noise out', () => {
  fs.mkdirSync(decisions, { recursive: true });
  fs.writeFileSync(path.join(decisions, '2026-11.md'), SAVED);
  fs.writeFileSync(path.join(decisions, '2026-10.md'), '# Decisions 2026-10\n\n- Dispatcher: Which mock-up? → B _(2026-10-02)_\n');
  const untouched = fs.statSync(path.join(decisions, '2026-10.md')).mtimeMs;
  assert.equal(cleanDecisionFiles(), 5);
  assert.equal(fs.readFileSync(path.join(decisions, '2026-11.md'), 'utf8'), '# Decisions 2026-11\n\n- Dispatcher: Push the v0.7.0 tag? → hold: test it first _(2026-11-26)_\n');
  const copies = fs.readdirSync(backups).filter((n) => n.startsWith('memory-decisions-'));
  assert.deepEqual(copies.map((n) => n.slice(0, 'memory-decisions-2026-11'.length)), ['memory-decisions-2026-11'], 'only the changed file is copied');
  assert.equal(fs.readFileSync(path.join(backups, copies[0]), 'utf8'), SAVED);
  assert.equal(fs.statSync(path.join(decisions, '2026-10.md')).mtimeMs, untouched);
  // A second launch finds nothing to take out and makes no second copy.
  assert.equal(cleanDecisionFiles(), 0);
  assert.equal(fs.readdirSync(backups).filter((n) => n.startsWith('memory-decisions-')).length, 1);
});

test('memory: recall and the digest no longer show permission answers', () => {
  assert.deepEqual(searchMemory('Run this command').filter((h) => h.path.startsWith('decisions/')).map((h) => h.text), []);
  assert.deepEqual(searchMemory('Allow recall').filter((h) => h.path.startsWith('decisions/')), []);
  assert.equal(searchMemory('v0.7.0 tag').some((h) => h.text.includes('hold: test it first')), true, 'a real decision is still found');
  assert.doesNotMatch(memoryDigest(), /Run this command|Allow recall|Approve plan/);
});

test('memory: a decision saved before is not saved a second time', () => {
  const f = path.join(decisions, `${month()}.md`);
  remember('decision', 'Dispatcher: Which inbox mock-up? → Option B');
  remember('decision', 'Dispatcher: Which inbox mock-up? → Option B');
  remember('decision', 'Dispatcher: Which inbox mock-up? → Option C');
  assert.equal(fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.includes('Which inbox mock-up?')).length, 2);
});
