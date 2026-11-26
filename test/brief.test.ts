import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tr } from '../src/shared/i18n';
import type { Say } from '../src/shared/askWhy';
import { BRIEF_MAX, briefLine, cardBrief, clipBrief, dispatcherBrief, permissionBrief, riskyBrief, shellBrief } from '../src/shared/brief';
import { alwaysAskRule } from '../src/main/agents/permissions';

const en: Say = (k, v) => tr('en', k, v);
const ko: Say = (k, v) => tr('ko', k, v);
const kinds = (b: { tags?: { kind: string }[] }) => (b.tags ?? []).map((x) => x.kind);

test('brief: a line keeps the first sentence without Markdown or its full stop', () => {
  assert.equal(briefLine('**Remove** the `split` mode. Then keep the rest.'), 'Remove the split mode');
  assert.equal(briefLine('  one\n  line  '), 'one line');
  assert.equal(briefLine(null), '');
});

test('brief: a line is cut to BRIEF_MAX with an ellipsis, whoever wrote it', () => {
  const long = briefLine('x'.repeat(200));
  assert.equal(long.length, BRIEF_MAX);
  assert.ok(long.endsWith('…'));
  const b = clipBrief({ what: 'y'.repeat(100), why: 'z'.repeat(100), risk: '', out: 'o'.repeat(100), tags: [{ kind: 'rule', label: 'r'.repeat(80) }] });
  assert.ok([b.what, b.why, b.out!].every((s) => s.length <= BRIEF_MAX));
  assert.ok(b.tags![0].label!.length <= 32);
});

test('brief: git and PowerShell commands read as plain words with their risk class', () => {
  assert.deepEqual(shellBrief(ko, 'Bash', { command: 'git status --short' }), { what: '변경 파일 확인', tags: ['read'], known: true });
  assert.deepEqual(shellBrief(en, 'Bash', { command: 'npm install --no-audit --no-fund' }), { what: 'Install dependencies', tags: ['network', 'write'], known: true });
  const rm = shellBrief(ko, 'PowerShell', { command: 'Remove-Item -Recurse -Force .\\dist, .\\node_modules\\.cache' });
  assert.equal(rm.what, 'dist · node_modules/.cache 삭제');
  assert.deepEqual(rm.tags, ['delete']);
  assert.deepEqual(shellBrief(en, 'Bash', { command: 'gh api -X DELETE repos/o/r/git/refs/heads/x' }).tags, ['delete', 'network']);
  assert.deepEqual(shellBrief(en, 'Bash', { command: 'git push origin --delete agent/t-1' }).tags, ['delete', 'network']);
});

test('brief: a here-document written with cat is a file write, its body not read', () => {
  const b = shellBrief(en, 'Bash', { command: "cat > \"$TEMP/x/perm.py\" <<'PYEOF'\nimport os\nos.remove('a')\nPYEOF" });
  assert.equal(b.what, 'Write x/perm.py');
  assert.deepEqual(b.tags, ['write']);
});

test('brief: a > inside quotes is no write, a redirect on any line or without a space is', () => {
  assert.deepEqual(shellBrief(en, 'Bash', { command: 'git commit -m "a > b"' }).tags, ['write']);
  assert.equal(shellBrief(en, 'Bash', { command: 'git commit -m "a > b"' }).what, 'Commit changes');
  assert.deepEqual(shellBrief(en, 'Bash', { command: "git log --format='%h > %s'" }).tags, ['read']);
  assert.deepEqual(shellBrief(en, 'Bash', { command: 'git status 2>&1' }).tags, ['read']);
  assert.deepEqual(shellBrief(en, 'Bash', { command: 'ls>out.txt' }).tags, ['write']);
  assert.equal(shellBrief(en, 'Bash', { command: 'cd src\necho hi > ../d.txt' }).what, 'Write ../d.txt');
  assert.deepEqual(shellBrief(en, 'Bash', { command: 'cd src\ngit diff > ../d.patch' }).tags, ['write']);
});

test('brief: find -delete, a hard reset, a restore and a dropped stash are deletes', () => {
  for (const command of ['find . -name "*.log" -delete', 'find dist -exec rm -rf {} +', 'git reset --hard origin/main', 'git restore src/a.ts', 'git checkout -- .', 'git stash drop']) {
    assert.deepEqual(shellBrief(en, 'Bash', { command }).tags, ['delete'], command);
  }
  assert.deepEqual(shellBrief(en, 'Bash', { command: 'git reset HEAD~1' }).tags, ['write']);
  assert.deepEqual(shellBrief(en, 'Bash', { command: 'find . -name "*.ts"' }).tags, ['read']);
});

test('brief: sed -i, tee and a saved download write files; a bare git branch only lists', () => {
  assert.deepEqual(shellBrief(en, 'Bash', { command: "sed -i 's/a/b/' src/a.ts" }), { what: 'Write src/a.ts', tags: ['write'], known: true });
  assert.deepEqual(shellBrief(en, 'Bash', { command: 'echo hi | tee notes.md' }).tags, ['write']);
  assert.deepEqual(shellBrief(en, 'Bash', { command: 'curl -o x.zip https://example.com/x.zip' }).tags, ['network', 'write']);
  assert.deepEqual(shellBrief(en, 'Bash', { command: 'curl https://example.com/x' }).tags, ['network']);
  assert.deepEqual(shellBrief(en, 'Bash', { command: 'git branch' }).tags, ['read']);
  assert.deepEqual(shellBrief(en, 'Bash', { command: 'git branch feature' }).tags, ['write']);
});

test('brief: a command the table does not know uses Claude Code\'s description, else a warning to read it', () => {
  assert.equal(shellBrief(en, 'Bash', { command: 'frobnicate --all', description: 'Rebuild the frob index.' }).what, 'Rebuild the frob index');
  const none = shellBrief(ko, 'PowerShell', { command: 'Invoke-Frob -All' });
  assert.equal(none.what, '설명 없음 · 원문 확인');
  assert.deepEqual(none.tags, ['unknown']);
  assert.equal(none.known, false);
});

test('brief: a permission says why with its plan step, and an always-ask rule comes first as a badge', () => {
  const steps = [{ title: 'Rebase on main', doneAt: 'x' }, { title: 'Push the branch', doneAt: null }];
  const input = { command: 'git push --force origin feature' };
  const b = permissionBrief(ko, { tool: 'Bash', input, rule: alwaysAskRule('Bash', input, []), steps });
  assert.equal(b.what, '원격에 푸시');
  assert.equal(b.why, '2/2단계 · Push the branch');
  assert.deepEqual(b.tags, [{ kind: 'rule', label: tr('ko', 'ask.forcePush') }, { kind: 'network' }]);
  assert.equal(riskyBrief(b), true);
});

test('brief: without a plan step the why is the Worker\'s last sentence, and a file edit is a write', () => {
  const b = permissionBrief(en, { tool: 'Edit', input: { file_path: 'C:/r/src/a.ts' }, said: 'Fixing the import order. Then tests.' });
  assert.equal(b.why, 'Fixing the import order');
  assert.deepEqual(kinds(b), ['write']);
  assert.equal(riskyBrief(b), false);
});

test('brief: the Dispatcher\'s fields are clipped, and what falls back to its context', () => {
  const b = dispatcherBrief({ why: 'Hard to undo', risk: 'Unsigned installers', outcome: 'A draft release', context: 'Tag 169b42b. The workflow builds two installers.' });
  assert.deepEqual(b, { what: 'Tag 169b42b', why: 'Hard to undo', risk: 'Unsigned installers', out: 'A draft release' });
});

test('brief: an older plan card reads its summary lines, with a fixed why', () => {
  const b = cardBrief(ko, { source: 'plan', detail: '', code: 'x', reason: null, brief: null, summary: { what: 'Remove the split.', how: 'Drop paneMode.', output: 'A merged PR.', risk: 'Visual baselines change.' } });
  assert.deepEqual(b, { what: 'Remove the split', why: '계획 우선 작업 · 승인 전 변경 없음', risk: 'Visual baselines change', out: 'A merged PR' });
});

test('brief: a stored brief wins and is clipped again on the card', () => {
  const b = cardBrief(en, { source: 'dispatcher', detail: 'Long detail.', code: null, reason: { what: 'w', why: 'y' }, summary: null, brief: { what: 'q'.repeat(90), why: 'short', risk: '' } });
  assert.equal(b.what.length, BRIEF_MAX);
  assert.equal(b.why, 'short');
});
