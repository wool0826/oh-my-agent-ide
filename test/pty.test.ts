import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ANSI, Flow, keepTail, OutBatch, PTY_BATCH_MAX, PTY_BATCH_MS, ptyArgs, ptyChunks, ptyEnv, ptyFresh, ptyGone, ptyLabel, ptyShells, ptySize, termFont, termKey, termTheme } from '../src/shared/pty';

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

test('pty: a piece of output the window drew already (in the replay) is not drawn again, and one half drawn goes on where it was', () => {
  assert.equal(ptyFresh('abc', 10, 7), 'abc');
  assert.equal(ptyFresh('abc', 10, 12), '');
  assert.equal(ptyFresh('abc', 10, 10), '');
  assert.equal(ptyFresh('abcdef', 10, 7), 'def');
});

test("pty: a tab's chip names the program in front or the shell, and the repository it started in", () => {
  assert.equal(ptyLabel({ name: 'pwsh', fg: '', repo: '' }), 'pwsh');
  assert.equal(ptyLabel({ name: 'zsh', fg: 'vim', repo: 'app' }), 'vim · app');
});

test('pty: a tab goes away when its shell ended by itself with 0, and stays when stopped, failed or ended otherwise', () => {
  assert.equal(ptyGone({ code: 0, stopped: false }), true);
  assert.equal(ptyGone({ code: 0, stopped: true }), false);
  assert.equal(ptyGone({ code: 1, stopped: false }), false);
  assert.equal(ptyGone({ code: null, stopped: false }), false);
  assert.equal(ptyGone({ code: 0, error: 'spawn failed', stopped: false }), false);
});

const key = (code: string, m: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {}) => ({ code, ctrlKey: !!m.ctrl, shiftKey: !!m.shift, altKey: !!m.alt, metaKey: !!m.meta });

test('pty: in the terminal the shell gets Esc, Tab, Ctrl+C and the keys the app uses elsewhere', () => {
  const win = { mac: false, selection: false };
  for (const k of [key('Escape'), key('Tab'), key('KeyC', { ctrl: true }), key('KeyL', { ctrl: true }), key('KeyF', { ctrl: true }), key('KeyK', { ctrl: true }), key('KeyJ', { ctrl: true }), key('Slash', { ctrl: true }), key('KeyR', { ctrl: true }), key('ArrowUp'), key('KeyA')]) {
    assert.equal(termKey(k, win), 'shell', k.code);
  }
  assert.equal(termKey(key('KeyC', { ctrl: true }), { mac: true, selection: true }), 'shell', 'Ctrl+C on the Mac is always the shell');
});

test('pty: the app keeps Ctrl+` and the tab keys, and on the Mac the ⌘ keys', () => {
  for (const mac of [false, true]) {
    assert.equal(termKey(key('Backquote', { ctrl: true }), { mac, selection: false }), 'app');
    assert.equal(termKey(key('PageDown', { ctrl: true }), { mac, selection: false }), 'app');
  }
  assert.equal(termKey(key('KeyK', { meta: true }), { mac: true, selection: false }), 'app');
  assert.equal(termKey(key('KeyV', { meta: true }), { mac: true, selection: false }), 'app');
});

test('pty: on Windows Ctrl+C copies only while text is selected; Ctrl+Shift+C, Ctrl+V and Shift+Insert copy and paste', () => {
  const sel = { mac: false, selection: true };
  const none = { mac: false, selection: false };
  assert.equal(termKey(key('KeyC', { ctrl: true }), sel), 'copy');
  assert.equal(termKey(key('KeyC', { ctrl: true, shift: true }), none), 'copy');
  assert.equal(termKey(key('Insert', { ctrl: true }), none), 'copy');
  assert.equal(termKey(key('KeyV', { ctrl: true }), none), 'paste');
  assert.equal(termKey(key('KeyV', { ctrl: true, shift: true }), none), 'paste');
  assert.equal(termKey(key('Insert', { shift: true }), none), 'paste');
  assert.equal(termKey(key('KeyC', { ctrl: true, alt: true }), sel), 'shell', 'AltGr+C types a character');
});

test('pty: every colour the terminal takes is a token of both themes', () => {
  const tokens = fs.readFileSync('src/renderer/tokens.css', 'utf8');
  const block = (sel: string) => tokens.slice(tokens.indexOf(sel), tokens.indexOf('}', tokens.indexOf(sel)));
  const asked: string[] = [];
  const th = termTheme((t) => { asked.push(t); return `v${t}`; });
  assert.equal(Object.keys(th).length, 5 + ANSI.length * 2);
  assert.equal(th.brightMagenta, 'v--ansi-bright-magenta');
  for (const theme of [':root, [data-theme="dark"] {', '[data-theme="light"] {']) {
    for (const t of new Set(asked)) assert.ok(block(theme).includes(`${t}:`), `${t} in ${theme}`);
  }
});

test('pty: the terminal font puts fonts with Korean before the generic monospace', () => {
  assert.equal(termFont('Menlo, Consolas, monospace'), 'Menlo, Consolas, "D2Coding", "Malgun Gothic", "Apple SD Gothic Neo", monospace');
  assert.equal(termFont('"Fira Code"'), '"Fira Code", "D2Coding", "Malgun Gothic", "Apple SD Gothic Neo", monospace');
  assert.equal(termFont(''), '"D2Coding", "Malgun Gothic", "Apple SD Gothic Neo", monospace');
});
