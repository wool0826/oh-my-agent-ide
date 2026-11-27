import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkItem, failedCount, failedFirst, fixCommand, ghChecks, preflightPlan, toolCheck } from '../src/shared/preflight';
import { tr } from '../src/shared/i18n';

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

const en = (k: Parameters<typeof tr>[1], v?: Record<string, string | number>) => tr('en', k, v);

test('preflight: a missing tool reads "Not installed", with its install command and the searched folders to copy', () => {
  const searched = '/usr/bin:/bin:/usr/sbin:/opt/homebrew/bin:/opt/local/bin:/Users/me/.nix-profile/bin';
  const r = checkItem({ id: 'gh', ok: false, missing: true, detail: `not found in PATH: ${searched}`, cmd: 'brew install gh' }, en);
  assert.deepEqual([r.name, r.tone, r.short], ['GitHub CLI (gh)', 'bad', 'Not installed']);
  assert.deepEqual(r.fields, [{ label: 'Install', value: 'brew install gh', copy: true }, { label: 'Searched', value: searched, copy: true }]);
});

test('preflight: a missing tool with no command for the OS keeps the words that say how to fix it', () => {
  const r = checkItem({ id: 'git', ok: false, missing: true, detail: 'not found in PATH: /bin' }, en);
  assert.deepEqual(r.fields[0], { label: 'Fix', value: 'Install git, then restart the app.' });
});

test('preflight: a signed-out host reads "Not signed in", with its sign-in command and the message from gh', () => {
  const r = checkItem({ id: 'ghAuth', host: 'github.company.com', ok: false, detail: 'You are not logged into any GitHub hosts. To log in, run: gh auth login' }, en);
  assert.deepEqual([r.id, r.name, r.short], ['ghAuth:github.company.com', 'GitHub sign-in: github.company.com', 'Not signed in']);
  assert.deepEqual(r.fields.map((f) => [f.label, f.value]), [['Run', 'gh auth login --hostname github.company.com'], ['Error', 'You are not logged into any GitHub hosts. To log in, run: gh auth login']]);
});

test('preflight: a home folder that cannot be written keeps the whole error in its detail', () => {
  const e = "EACCES: permission denied, open '/Users/me/Library/Application Support/oh-my-agent-ide/data/.write-test-42'";
  const r = checkItem({ id: 'home', ok: false, detail: e }, en);
  assert.deepEqual([r.short, r.fields], ['Not writable', [{ label: 'Error', value: e, copy: true }]]);
});

test('preflight: fine checks show a version, a short path or a count, with the long form in the detail', () => {
  assert.equal(checkItem({ id: 'git', ok: true, detail: 'git version 2.47.1' }, en).short, '2.47.1');
  const home = checkItem({ id: 'home', ok: true, detail: '/Users/me/Library/Application Support/oh-my-agent-ide' }, en);
  assert.deepEqual([home.short, home.fields[0]!.value], ['…/Application Support/oh-my-agent-ide', '/Users/me/Library/Application Support/oh-my-agent-ide']);
  const acc = checkItem({ id: 'account', ok: true, detail: '3' }, en, ['Work', 'Personal', 'Backup']);
  assert.deepEqual([acc.short, acc.fields], ['3 accounts', [{ label: 'Accounts', value: 'Work, Personal, Backup' }]]);
});

test('preflight: a tool that runs but fails shows the start of its error and the whole of it below', () => {
  const r = checkItem({ id: 'codex', ok: false, detail: 'Error: Not logged in. Run codex login to continue.' }, en);
  assert.equal(r.short, 'Not logged in');
  assert.deepEqual(r.fields.map((f) => f.label), ['Run', 'Error']);
});
