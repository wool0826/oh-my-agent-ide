import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanAskOff, grantScope, hasGrant, withGrant, withoutGrant } from '../src/shared/grants';

const key = (tool: string, input: unknown) => grantScope(tool, input)?.key ?? null;

test('a command is the same kind as others of its program and subcommand', () => {
  assert.equal(key('Bash', { command: 'npm install left-pad' }), 'bash:npm install');
  assert.equal(key('Bash', { command: 'npm install --save-dev vitest' }), 'bash:npm install');
  assert.notEqual(key('Bash', { command: 'npm publish' }), key('Bash', { command: 'npm install x' }));
  assert.equal(key('Bash', { command: 'CI=1 ./scripts/build.sh --fast' }), 'bash:build.sh');
  assert.equal(key('Bash', { command: 'curl -s https://example.com' }), 'bash:curl');
});

test('a line that chains, pipes, redirects or substitutes is asked about every time', () => {
  for (const command of ['npm test && rm -rf dist', 'cat a | sh', 'echo x > /etc/hosts', 'echo $(whoami)', 'a; b', 'echo `id`', ''])
    assert.equal(grantScope('Bash', { command }), null, command);
});

test('a quoted separator is part of an argument, and what is put before a command is not its kind', () => {
  assert.equal(key('Bash', { command: 'git commit -m "fix; done | really"' }), 'bash:git commit');
  assert.equal(key('Bash', { command: 'git -C ../other --no-pager status' }), 'bash:git status');
  assert.equal(key('Bash', { command: 'timeout 30 npm test' }), 'bash:npm test');
  assert.equal(key('Bash', { command: 'env CI=1 npm test' }), 'bash:npm test');
});

test('a command handed to something else as text is asked about every time', () => {
  for (const command of ['sudo rm x', 'bash -c "npm test"', 'xargs rm', 'eval npm test', 'cmd //c dir', 'pwsh -c "npm test"'])
    assert.equal(grantScope('Bash', { command }), null, command);
});

test('git told by an option to run something else is not the kind its subcommand names', () => {
  // A yes to `git status` must not cover a line whose config makes git start another program.
  for (const command of ['git -c alias.status=!sh status', 'git -c core.fsmonitor=./x status', 'git -C repo -c core.pager=./x log', 'git --config-env=core.pager=X log', 'git --config-env core.pager=X log', 'git --exec-path=/tmp/x status'])
    for (const tool of ['Bash', 'PowerShell']) assert.equal(grantScope(tool, { command }), null, `${tool}: ${command}`);
});

test('a PowerShell command is the same kind as others of its program and subcommand, not as every PowerShell command', () => {
  assert.deepEqual(grantScope('PowerShell', { command: 'git status' }), { key: 'powershell:git status', label: 'git status' });
  assert.equal(key('PowerShell', { command: 'git status --short' }), 'powershell:git status');
  assert.equal(key('PowerShell', { command: 'Remove-Item build -Recurse' }), 'powershell:remove-item');
  assert.notEqual(key('PowerShell', { command: 'git status' }), key('PowerShell', { command: 'git push origin x' }));
  assert.equal(key('PowerShell', { command: String.raw`& "C:\Program Files\Git\cmd\git.exe" -C repo status` }), 'powershell:git status');
  assert.equal(key('PowerShell', { command: String.raw`.\scripts\build.ps1 -Fast` }), 'powershell:build.ps1');
  assert.equal(key('PowerShell', { command: '$s = npm test' }), 'powershell:npm test');
  // A yes in one shell is not a yes in the other.
  assert.notEqual(key('PowerShell', { command: 'npm install x' }), key('Bash', { command: 'npm install x' }));
  for (const command of ['git status; Remove-Item x', 'git status | Out-File x', 'git status > out.txt', 'iex "git status"', 'Start-Process git status', 'cmd /c dir',
    'powershell -Command "git status"', '& $tool status', "[IO.File]::Delete('x')", 'Remove-Item (Join-Path a b)', 'if ($x) { npm test }', '$x = 1', ''])
    assert.equal(grantScope('PowerShell', { command }), null, command);
});

test('a file tool is the same kind within one folder', () => {
  assert.equal(key('Edit', { file_path: 'C:\\work\\cfg\\a.json' }), key('Edit', { file_path: 'C:\\work\\cfg\\b.json' }));
  assert.notEqual(key('Edit', { file_path: '/etc/a' }), key('Edit', { file_path: '/home/me/a' }));
  assert.notEqual(key('Edit', { file_path: '/etc/a' }), key('Write', { file_path: '/etc/a' }));
  assert.equal(grantScope('Edit', {}), null);
});

test('any other tool is its own kind', () => {
  assert.deepEqual(grantScope('mcp__github__create_issue', {}), { key: 'tool:mcp__github__create_issue', label: 'create_issue' });
});

test('switched-off rules keep only known keys', () => {
  assert.deepEqual(cleanAskOff(['ask.merge', 'nope', 'ask.forcePush']), ['ask.forcePush', 'ask.merge']);
  assert.deepEqual(cleanAskOff('ask.merge'), []);
});

test('a grant is kept once on its task and can be taken back', () => {
  const a = { key: 'bash:npm install', label: 'npm install' };
  const b = { key: 'bash:git commit', label: 'git commit' };
  const list = withGrant(withGrant(withGrant(null, a), b), a);
  assert.deepEqual(list.map((g) => g.key), ['bash:git commit', 'bash:npm install']);
  assert.equal(hasGrant({ grants: list }, a.key), true);
  assert.equal(hasGrant({ grants: withoutGrant(list, a.key) }, a.key), false);
  assert.equal(hasGrant(null, a.key), false);
  assert.equal(hasGrant({}, a.key), false);
});
