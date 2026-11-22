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
