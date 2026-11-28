import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Flow, keepTail, OutBatch, PTY_BATCH_MAX, PTY_BATCH_MS, ptyArgs, ptyChunks, ptyEnv, ptyShells, ptySize } from '../src/shared/pty';

const none = () => false;

test('pty: on Windows the shells are PowerShell 7 when installed, then Windows PowerShell, then the Command Prompt', () => {
  const pwsh = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
  assert.deepEqual(ptyShells({ platform: 'win32', pwsh, comspec: 'C:\\WINDOWS\\system32\\cmd.exe', exists: none }), [
    { id: 'pwsh', name: 'pwsh', file: pwsh },
    { id: 'powershell', name: 'powershell', file: 'powershell.exe' },
    { id: 'cmd', name: 'cmd', file: 'C:\\WINDOWS\\system32\\cmd.exe' },
  ]);
  assert.deepEqual(ptyShells({ platform: 'win32', pwsh: null, exists: none }).map((s) => s.id), ['powershell', 'cmd']);
});

test("pty: on macOS the user's login shell comes first, then the usual ones that exist, each once", () => {
  const there = new Set(['/opt/homebrew/bin/fish', '/bin/zsh', '/bin/bash', '/bin/sh']);
  const shells = ptyShells({ platform: 'darwin', shell: '/opt/homebrew/bin/fish', exists: (f) => there.has(f) });
  assert.deepEqual(shells.map((s) => s.file), ['/opt/homebrew/bin/fish', '/bin/zsh', '/bin/bash', '/bin/sh']);
  assert.deepEqual(shells.map((s) => s.id), ['fish', 'zsh', 'bash', 'sh']);
});

test('pty: a $SHELL that is not an absolute path to a file is passed over', () => {
  assert.deepEqual(ptyShells({ platform: 'darwin', shell: 'zsh', exists: (f) => f === '/bin/zsh' }).map((s) => s.file), ['/bin/zsh']);
  assert.deepEqual(ptyShells({ platform: 'linux', shell: '/usr/bin/gone', exists: none }).map((s) => s.file), ['/bin/sh']);
});

test('pty: a shell starts as a login shell, or without any start file when the profile is off', () => {
  const a = (name: string, profile: boolean) => ptyArgs({ id: name, name }, profile);
  assert.deepEqual(a('pwsh', true), ['-NoLogo']);
  assert.deepEqual(a('powershell', false), ['-NoLogo', '-NoProfile']);
  assert.deepEqual(a('cmd', true), []);
  assert.deepEqual(a('cmd', false), ['/D']);
  assert.deepEqual(a('zsh', true), ['-l']);
  assert.deepEqual(a('zsh', false), ['-f']);
  assert.deepEqual(a('bash', false), ['--noprofile', '--norc']);
  assert.deepEqual(a('fish', false), ['--no-config']);
  assert.deepEqual(a('ksh', true), ['-l']);
  assert.deepEqual(a('ksh', false), []);
});

test("pty: the shell's environment names the terminal and drops what only the app needs", () => {
  const env = ptyEnv({ PATH: '/bin', HOME: '/Users/me', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_USE_BEDROCK: '1', ELECTRON_RUN_AS_NODE: '1', OMA_DATA_DIR: '/tmp/x', GH_HOST: 'ghe.example', GONE: undefined }, { platform: 'darwin', version: '0.9.0' });
  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(env.COLORTERM, 'truecolor');
  assert.equal(env.TERM_PROGRAM, 'OhMyAgentIDE');
  assert.equal(env.TERM_PROGRAM_VERSION, '0.9.0');
  assert.equal(env.GH_HOST, 'ghe.example');
  // The user's own Claude Code settings stay; the markers of a session the app was started from go.
  assert.equal(env.CLAUDE_CODE_USE_BEDROCK, '1');
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'ELECTRON_RUN_AS_NODE', 'OMA_DATA_DIR', 'GONE']) assert.equal(k in env, false, k);
});

test('pty: on macOS and Linux a UTF-8 locale is set only when none is', () => {
  assert.equal(ptyEnv({}, { platform: 'darwin', version: '1' }).LANG, 'en_US.UTF-8');
  assert.equal(ptyEnv({ LANG: 'ko_KR.UTF-8' }, { platform: 'darwin', version: '1' }).LANG, 'ko_KR.UTF-8');
  assert.equal(ptyEnv({ LC_ALL: 'C' }, { platform: 'linux', version: '1' }).LANG, undefined);
  assert.equal(ptyEnv({}, { platform: 'win32', version: '1' }).LANG, undefined);
});

test('pty: a size is whole columns and rows in range, 80 × 24 for nonsense', () => {
  assert.deepEqual(ptySize(120.7, 30.2), { cols: 120, rows: 30 });
  assert.deepEqual(ptySize(1, 0.5), { cols: 2, rows: 24 });
  assert.deepEqual(ptySize(99999, 9999), { cols: 500, rows: 300 });
  assert.deepEqual(ptySize('x', -3), { cols: 80, rows: 24 });
});

test('pty: a long paste goes in pieces of the most a write takes, never inside an emoji', () => {
  assert.deepEqual(ptyChunks('abcdefg', 3), ['abc', 'def', 'g']);
  assert.deepEqual(ptyChunks('', 3), []);
  // '😀' is two UTF-16 units: the piece that would end on its first half ends before it.
  assert.deepEqual(ptyChunks('ab😀cd', 3), ['ab', '😀c', 'd']);
  assert.equal(ptyChunks('x'.repeat(10)).length, 1);
});

test('pty: the output kept to draw again is its end, from a line start', () => {
  assert.equal(keepTail('ab\n', 'cd', 10), 'ab\ncd');
  assert.equal(keepTail('line1\nline2\n', 'line3\n', 12), 'line3\n');
  // One long line with no break: its end, as it is.
  assert.equal(keepTail('', 'x'.repeat(20), 8), 'x'.repeat(8));
});

function fakeTimers() {
  const due: { fn: () => void; ms: number }[] = [];
  return {
    due,
    timers: { set: (fn: () => void, ms: number) => { const t = { fn, ms }; due.push(t); return t; }, clear: (t: unknown) => { const i = due.indexOf(t as { fn: () => void; ms: number }); if (i >= 0) due.splice(i, 1); } },
    run() { for (const t of due.splice(0)) t.fn(); },
  };
}

test('pty: output pieces go out together once per batch time', () => {
  const sent: string[] = [];
  const ft = fakeTimers();
  const b = new OutBatch((d) => sent.push(d), ft.timers);
  b.push('a'); b.push('b'); b.push('c');
  assert.deepEqual(sent, []);
  assert.equal(ft.due.length, 1);
  assert.equal(ft.due[0].ms, PTY_BATCH_MS);
  ft.run();
  assert.deepEqual(sent, ['abc']);
  b.push('d');
  b.flush();
  assert.deepEqual(sent, ['abc', 'd']);
  assert.equal(ft.due.length, 0, 'a flush clears its timer');
  b.flush();
  assert.deepEqual(sent, ['abc', 'd'], 'nothing gathered, nothing sent');
});

test('pty: a batch past its size goes at once', () => {
  const sent: string[] = [];
  const ft = fakeTimers();
  const b = new OutBatch((d) => sent.push(d), ft.timers);
  b.push('x'.repeat(PTY_BATCH_MAX - 1));
  b.push('yz');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].length, PTY_BATCH_MAX + 1);
  assert.equal(ft.due.length, 0);
});

test('pty: the shell pauses past the high mark of output not drawn, and goes on under the low mark, once each', () => {
  const f = new Flow(100, 20);
  assert.equal(f.sent(60), false);
  assert.equal(f.sent(60), true);
  assert.equal(f.sent(10), false, 'already paused');
  assert.equal(f.drawn(50), false, '80 still out');
  assert.equal(f.drawn(70), true);
  assert.equal(f.drawn(5), false, 'already going');
  assert.equal(f.unacked, 5);
  assert.equal(f.drawn(99), false);
  assert.equal(f.unacked, 0, 'never below nothing');
});

test('pty: a reload of the window forgets what was waiting to be drawn', () => {
  const f = new Flow(10, 5);
  f.sent(50);
  assert.equal(f.paused, true);
  assert.equal(f.reset(), true);
  assert.equal(f.unacked, 0);
  assert.equal(f.reset(), false);
});
