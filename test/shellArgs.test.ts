// How "!" lines, saved scripts and the side terminal start their shell (shared/shell.ts shellArgs): interactive with
// the user's rc files or PowerShell profile when Settings says so, and what the rc files print kept out of the output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dropRcNoise, PS_ENCODED_MAX, psLine, RC_DONE, RC_NOISE_MAX, shellArgs } from '../src/shared/shell';

test('macOS and Linux: -ilc through /bin/sh with the marker when the profile is on, -lc as before when off', () => {
  const on = shellArgs({ platform: 'darwin', shell: '/bin/zsh', cmd: 'gs', profile: true });
  assert.equal(on.file, '/bin/sh');
  assert.deepEqual(on.args.slice(0, 3), ['-c', 'exec "$0" -ilc "$1"', '/bin/zsh']);
  assert.equal(on.args[3], `command printf '%s\\n' ${RC_DONE}\ncommand printf '%s\\n' ${RC_DONE} >&2\ngs`);
  assert.equal(on.marked, true);
  for (const shell of ['/bin/bash', '/usr/local/bin/fish', '/bin/sh', '/bin/ksh', '/bin/dash']) {
    assert.equal(shellArgs({ platform: 'linux', shell, cmd: 'x', profile: true }).marked, true, shell);
  }
  assert.deepEqual(shellArgs({ platform: 'darwin', shell: '/bin/zsh', cmd: 'gs', profile: false }), { file: '/bin/zsh', args: ['-lc', 'gs'], marked: false });
  // A shell that does not take -i, -l and -c together runs as before.
  assert.deepEqual(shellArgs({ platform: 'linux', shell: '/bin/tcsh', cmd: 'ls', profile: true }), { file: '/bin/tcsh', args: ['-lc', 'ls'], marked: false });
});

test('Windows: PowerShell 7 with the profile when on and found, Windows PowerShell without it when off', () => {
  const pwsh = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
  const on = shellArgs({ platform: 'win32', shell: '', cmd: 'gs', profile: true, pwsh });
  assert.equal(on.file, pwsh);
  assert.deepEqual(on.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  assert.equal(on.args[3], psLine('gs', true));
  assert.match(on.args[3], /\$PROFILE\.CurrentUserCurrentHost/);
  assert.equal(shellArgs({ platform: 'win32', shell: '', cmd: 'gs', profile: true, pwsh: null }).file, 'powershell.exe');
  const off = shellArgs({ platform: 'win32', shell: '', cmd: 'gs', profile: false, pwsh });
  assert.equal(off.file, 'powershell.exe');
  assert.equal(off.args[3], psLine('gs'));
  assert.doesNotMatch(off.args[3], /PROFILE/);
  assert.equal(off.marked, false);
});

test('what comes before the marker is dropped, also when the marker is split between chunks', () => {
  let r = dropRcNoise('', 'bash: no job control in this shell\nhello from .zshrc\n__oma_rc');
  assert.deepEqual(r, { show: '', pending: 'bash: no job control in this shell\nhello from .zshrc\n__oma_rc' });
  r = dropRcNoise(r.pending, '_done__\nOn branch main\n');
  assert.deepEqual(r, { show: 'On branch main\n', pending: null });
  // Past the marker everything shows, a marker in the command's own output too.
  assert.deepEqual(dropRcNoise(null, `${RC_DONE}\nx`), { show: `${RC_DONE}\nx`, pending: null });
  // A shell that ended before the marker (rc failed, stopped while starting) shows what it printed.
  assert.deepEqual(dropRcNoise('zsh: no such file', '', true), { show: 'zsh: no such file', pending: null });
  // No marker after a lot of output (an rc file that exec's another program): it all shows from then on.
  const big = 'x'.repeat(RC_NOISE_MAX + 1);
  assert.deepEqual(dropRcNoise('', big), { show: big, pending: null });
});

/** Runs a spawn plan with the given environment; Windows has no /bin/sh, so its Git `sh` stands in. */
function runPlan(plan: { file: string; args: string[] }, env: NodeJS.ProcessEnv) {
  const file = process.platform === 'win32' && plan.file === '/bin/sh' ? 'sh' : plan.file;
  const r = spawnSync(file, plan.args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000, windowsHide: true });
  return { out: r.stdout ?? '', err: r.stderr ?? '', code: r.status, error: r.error };
}

const hasBash = spawnSync('bash', ['-c', 'exit 0'], { stdio: 'ignore' }).status === 0 && spawnSync(process.platform === 'win32' ? 'sh' : '/bin/sh', ['-c', 'exit 0'], { stdio: 'ignore' }).status === 0;

test('an interactive bash reads ~/.bashrc: its alias works and what it prints at start is not in the output', { skip: !hasBash && 'no bash here' }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-rc-'));
  fs.writeFileSync(path.join(home, '.bashrc'), 'echo greeting from bashrc\nalias gs="echo alias-ok"\nread -r answer\n');
  fs.writeFileSync(path.join(home, '.bash_profile'), '. ~/.bashrc\necho noise >&2\n');
  const env = { ...process.env, HOME: home };
  const plan = shellArgs({ platform: 'linux', shell: 'bash', cmd: 'gs; echo err >&2; (exit 3)', profile: true });
  const r = runPlan(plan, env);
  assert.equal(r.code, 3);
  // Each pipe drops what the rc files printed up to its own marker: the command's output on stdout, its error
  // (and not the rc files' "noise") on stderr.
  assert.equal(dropRcNoise('', r.out, true).show.replace(/\r/g, ''), 'alias-ok\n');
  assert.equal(dropRcNoise('', r.err, true).show.replace(/\r/g, ''), 'err\n');
  // Off: a login shell that is not interactive has no alias.
  const off = runPlan(shellArgs({ platform: 'linux', shell: 'bash', cmd: 'gs', profile: false }), env);
  assert.notEqual(off.code, 0);
});

test('Windows PowerShell with the profile: exit codes stay the line\'s own', { skip: process.platform !== 'win32' && 'Windows only' }, () => {
  for (const [cmd, code] of [['Write-Output hi', 0], ['cmd /c exit 7', 7], ['Get-Item C:\\no-such-thing-oma', 1]] as const) {
    const r = runPlan(shellArgs({ platform: 'win32', shell: '', cmd, profile: true, pwsh: null }), process.env);
    assert.equal(r.code, code, cmd);
  }
  const r = runPlan(shellArgs({ platform: 'win32', shell: '', cmd: 'Write-Output hi', profile: true, pwsh: null }), process.env);
  assert.equal(r.out.trim(), 'hi');
});

test('psLine: the line goes in encoded, to be read after the UTF-8 line; a very long one goes as it is', () => {
  const line = 'echo "한글" && echo done';
  const ps = psLine(line);
  assert.ok(ps.startsWith('[Console]::OutputEncoding = [Text.Encoding]::UTF8\n'));
  assert.ok(!ps.includes('한글'));
  const body = Buffer.from(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(ps)![1], 'base64').toString('utf8');
  assert.equal(body, `${line}\n$ok = $?; if ($ok) { exit 0 } elseif ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 }`);
  // The profile is loaded outside the encoded part, before the line is read.
  assert.ok(psLine(line, true).indexOf('$PROFILE.CurrentUserCurrentHost') < psLine(line, true).indexOf('FromBase64String'));
  const long = `echo ${'x'.repeat(PS_ENCODED_MAX)}`;
  assert.ok(psLine(long).includes(long));
  assert.doesNotMatch(psLine(long), /FromBase64String/);
});

test('Windows PowerShell: a line it cannot read says why in UTF-8 and ends with 1, and other lines run as before', { skip: process.platform !== 'win32' && 'Windows only' }, () => {
  const run = (cmd: string, profile = false) => {
    const plan = shellArgs({ platform: 'win32', shell: '', cmd, profile, pwsh: null });
    const r = spawnSync(plan.file, plan.args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000, windowsHide: true });
    return { code: r.status, out: r.stdout.toString('utf8').replace(/\r/g, ''), err: r.stderr.toString('utf8') };
  };
  // "&&" is not Windows PowerShell's, and a quote left open is nobody's: the reason is readable, not the console's code page.
  for (const bad of ['echo a && echo b', 'echo "open']) {
    const r = run(bad);
    assert.equal(r.code, 1, bad);
    assert.equal(r.out, '', bad);
    assert.ok(r.err.trim().length > 0 && !r.err.includes('�'), `${bad}: ${r.err}`);
  }
  // The message quotes the line: Korean in it reads as Korean on any console code page, with the profile loaded too.
  for (const profile of [false, true]) {
    const r = run('echo "한글', profile);
    assert.equal(r.code, 1);
    assert.match(r.err, /한글/);
  }
  assert.deepEqual(run('echo 한글; cmd /c exit 3'), { code: 3, out: '한글\n', err: '' });
  assert.deepEqual(run('echo one\necho two'), { code: 0, out: 'one\ntwo\n', err: '' });
  assert.equal(run('exit 7').code, 7);
});
