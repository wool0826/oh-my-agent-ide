import { test } from 'node:test';
import assert from 'node:assert/strict';
import { augmentedPath, commonToolDirs, findTool, notFoundMessage, parseShellPath, PATH_MARKER } from '../src/shared/toolpath';
import { run } from '../src/main/util';
import { loginShellPath } from '../src/main/toolpath';

test('the app PATH comes first, then the login shell PATH, then the common folders, each once', () => {
  const p = augmentedPath({ platform: 'darwin', current: '/usr/bin:/bin', shellPath: '/Users/me/.cargo/bin:/opt/homebrew/bin:/usr/bin', home: '/Users/me' }).split(':');
  assert.deepEqual(p.slice(0, 4), ['/usr/bin', '/bin', '/Users/me/.cargo/bin', '/opt/homebrew/bin']);
  assert.equal(new Set(p).size, p.length);
  for (const d of ['/usr/local/bin', '/opt/local/bin', '/Users/me/.nix-profile/bin']) assert.ok(p.includes(d), d);
  assert.ok(p.indexOf('/opt/homebrew/bin') < p.indexOf('/usr/local/bin'));
});

test('without a login shell PATH the common folders are still added; empty parts are dropped', () => {
  const p = augmentedPath({ platform: 'linux', current: '::/usr/bin:', shellPath: null, home: '/home/me/' });
  assert.ok(!p.split(':').includes(''));
  assert.equal(p.split(':')[0], '/usr/bin');
  assert.ok(p.includes('/home/me/.nix-profile/bin'));
  assert.ok(!commonToolDirs('').some((d) => d.startsWith('/.')));
});

test('Windows keeps its PATH as it is', () => {
  assert.equal(augmentedPath({ platform: 'win32', current: 'C:\Windows;C:\Program Files\GitHub CLI', shellPath: '/x', home: 'C:\Users\me' }), 'C:\Windows;C:\Program Files\GitHub CLI');
  assert.equal(findTool('gh', { platform: 'win32', path: '', exists: () => true }), null);
});

test('the login shell PATH is read after the marker, past what startup files print', () => {
  assert.equal(parseShellPath(`Welcome!\nnvm loaded\n${PATH_MARKER}/opt/homebrew/bin:/usr/bin`), '/opt/homebrew/bin:/usr/bin');
  assert.equal(parseShellPath('no marker here'), null);
  assert.equal(parseShellPath(PATH_MARKER), null);
});

test('a missing shell gives no PATH instead of failing', async () => {
  assert.equal(await loginShellPath(undefined), null);
  assert.equal(await loginShellPath('/no/such/shell-oma', 1_000), null);
  // A program that is not a usable shell gives no PATH, quickly.
  const t0 = Date.now();
  assert.equal(await loginShellPath(process.execPath, 300).catch(() => 'threw'), null);
  assert.ok(Date.now() - t0 < 5_000);
});

test('gh is looked for in Homebrew, /usr/local and MacPorts before the PATH', () => {
  const have = new Set(['/usr/local/bin/gh', '/custom/bin/gh']);
  assert.equal(findTool('gh', { platform: 'darwin', path: '/custom/bin:/usr/bin', exists: (f) => have.has(f) }), '/usr/local/bin/gh');
  assert.equal(findTool('gh', { platform: 'darwin', path: '/custom/bin/', exists: (f) => f === '/custom/bin/gh' }), '/custom/bin/gh');
  assert.equal(findTool('gh', { platform: 'linux', path: '/usr/bin', exists: () => false }), null);
  assert.equal(findTool('/abs/gh', { platform: 'darwin', path: '', exists: () => true }), null);
});

test('a program that cannot be started reads as "not found", not "spawn … ENOENT"', async () => {
  if (process.platform === 'win32') return; // Windows keeps the old message (see util.run)
  const r = await run('oma-no-such-tool-xyz', ['--version'], { env: { ...process.env, PATH: '/nowhere' } });
  assert.notEqual(r.code, 0);
  assert.equal(r.missing, true);
  assert.match(r.stderr, /^oma-no-such-tool-xyz not found\. Searched: .*\/nowhere/);
  assert.doesNotMatch(r.stderr, /ENOENT/);
});

test('the not-found message names the folders searched and how to install and sign in', () => {
  assert.match(notFoundMessage('gh', '/usr/bin'), /gh not found\. Searched: \/opt\/homebrew\/bin:.*brew install gh.*gh auth login/);
});
