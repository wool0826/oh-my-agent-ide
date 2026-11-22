import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failedCount, failedFirst, fixCommand, ghChecks, preflightPlan, toolCheck } from '../src/shared/preflight';

test('the plan checks github.com, the company host when set, and Codex only when it is used', () => {
  assert.deepEqual(preflightPlan({ githubHost: '', models: ['claude-opus-5-5'], providers: ['claude'], fake: false }), { hosts: ['github.com'], codex: false, account: true });
  assert.deepEqual(preflightPlan({ githubHost: ' GitHub.Company.com ', models: ['claude-opus-5-5', 'gpt-6-luna'], providers: ['claude'], fake: false }).hosts, ['github.com', 'github.company.com']);
  assert.equal(preflightPlan({ githubHost: 'github.com', models: [], providers: ['chatgpt'], fake: false }).codex, true);
  assert.equal(preflightPlan({ githubHost: '', models: ['gpt-6-luna'], providers: [], fake: false }).codex, true);
});

test('fake agents need no account and no Codex', () => {
  assert.deepEqual(preflightPlan({ githubHost: '', models: ['gpt-6-luna'], providers: ['chatgpt'], fake: true }), { hosts: ['github.com'], codex: false, account: false });
});

test('a failed sign-in names the command that fixes it', () => {
  assert.equal(fixCommand({ id: 'ghAuth', host: 'github.company.com' }), 'gh auth login --hostname github.company.com');
  assert.equal(fixCommand({ id: 'codex' }), 'codex login');
  assert.equal(fixCommand({ id: 'git' }), null);
});

test('what failed is listed first', () => {
  const checks = [{ id: 'git' as const, ok: true, detail: '' }, { id: 'gh' as const, ok: false, detail: '' }, { id: 'home' as const, ok: true, detail: '' }];
  assert.deepEqual(failedFirst(checks).map((c) => c.id), ['gh', 'git', 'home']);
  assert.equal(failedCount(checks), 1);
});

test('a missing tool gets its install command for the OS; one that is there but failing does not', () => {
  assert.equal(fixCommand({ id: 'gh', missing: true }, 'darwin'), 'brew install gh');
  assert.equal(fixCommand({ id: 'gh', missing: true }, 'win32'), 'winget install --id GitHub.cli -e');
  assert.equal(fixCommand({ id: 'gh', missing: true }, 'linux'), null);
  assert.equal(fixCommand({ id: 'codex', missing: true }, 'darwin'), 'npm install -g @openai/codex');
  assert.equal(fixCommand({ id: 'gh' }, 'darwin'), null);
});

test('gh not found and gh not signed in are told apart', async () => {
  const missing = await ghChecks(async () => ({ code: 1, stdout: '', stderr: 'gh not found', missing: true }), ['github.com'], '/usr/bin:/bin');
  assert.deepEqual(missing, [{ id: 'gh', ok: false, missing: true, detail: 'not found in PATH: /usr/bin:/bin' }]);

  const calls: string[] = [];
  const signedOut = await ghChecks(async (args, host) => {
    calls.push(`${args.join(' ')}${host ? ` @${host}` : ''}`);
    return args[0] === '--version' ? { code: 0, stdout: 'gh version 2.80.0\nhttps://…', stderr: '' } : { code: 1, stdout: '', stderr: 'You are not logged into any GitHub hosts.' };
  }, ['github.com'], '');
  assert.deepEqual(calls, ['--version', 'auth status --hostname github.com @github.com']);
  assert.deepEqual(signedOut.map((c) => [c.id, c.ok, !!c.missing]), [['gh', true, false], ['ghAuth', false, false]]);
  assert.equal(signedOut[0].detail, 'gh version 2.80.0');
  assert.equal(fixCommand(signedOut[1]), 'gh auth login --hostname github.com');
});

test('a tool that runs but fails is not reported as missing', () => {
  assert.deepEqual(toolCheck('git', { code: 128, stdout: '', stderr: 'xcrun: error: invalid active developer path\nmore' }, ''), { id: 'git', ok: false, detail: 'xcrun: error: invalid active developer path' });
});
