import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeHome, memoryDirFor, projectSlug, searchClaudeMemory, userRules } from '../src/main/claudeContext';

test('claude: project folder name follows Claude Code', () => {
  if (process.platform === 'win32') {
    assert.equal(projectSlug('D:\\AI\\project\\oh-my-agent-ide'), 'D--AI-project-oh-my-agent-ide');
    assert.equal(projectSlug('C:\\Users\\me\\OhMyAgentIDE\\repos\\my.repo'), 'C--Users-me-OhMyAgentIDE-repos-my-repo');
  } else {
    assert.equal(projectSlug('/Users/me/work/my.repo'), '-Users-me-work-my-repo');
  }
});

test('claude: CLAUDE_CONFIG_DIR wins over ~/.claude', () => {
  assert.equal(claudeHome({ CLAUDE_CONFIG_DIR: '/x/cfg' }), '/x/cfg');
  assert.equal(claudeHome({}), path.join(os.homedir(), '.claude'));
});

test('claude: rules come from CLAUDE.md and rules/*.md, settings stay out', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-claude-'));
  try {
    assert.equal(userRules(home), '');
    fs.writeFileSync(path.join(home, 'CLAUDE.md'), 'Answer in Korean.\n');
    fs.mkdirSync(path.join(home, 'rules'));
    fs.writeFileSync(path.join(home, 'rules', 'b.md'), 'No emoji.');
    fs.writeFileSync(path.join(home, 'rules', 'a.md'), 'Small commits.');
    fs.writeFileSync(path.join(home, 'settings.json'), '{"permissions":{}}');
    const r = userRules(home);
    assert.ok(r.indexOf('Answer in Korean.') < r.indexOf('Small commits.'));
    assert.ok(r.indexOf('Small commits.') < r.indexOf('No emoji.'));
    assert.ok(!r.includes('permissions'));
    assert.ok(userRules(home, 20).endsWith('…'));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('claude: auto-memory folder and search', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-claude-'));
  try {
    const repo = path.join(home, 'work', 'repo');
    const dir = memoryDirFor(repo, home);
    assert.equal(dir, path.join(home, 'projects', projectSlug(repo), 'memory'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'MEMORY.md'), '- [Build](build.md) — use esbuild\n');
    fs.writeFileSync(path.join(dir, 'build.md'), 'Tests run with node --test after an esbuild bundle.\n');
    const hits = searchClaudeMemory('esbuild tests', [dir, dir, path.join(home, 'missing')]);
    assert.equal(hits[0].file, path.join(dir, 'build.md'));
    assert.equal(hits.length, 2);
    assert.deepEqual(searchClaudeMemory('', [dir]), []);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
