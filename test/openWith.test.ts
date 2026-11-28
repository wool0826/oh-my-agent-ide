import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanEditor, cleanEditorCmd, cleanTerminal, cmdLine, commandName, editorLabel, editorLaunch, editorProgram, fillPath,
  menuEditors, presetTemplate, splitCommand, terminalLaunch, terminalsFor, type Found,
} from '../src/shared/openWith';

const has = (bins: string[], apps: string[] = []): Found => ({ bin: (n) => bins.includes(n), macApp: (n) => apps.includes(n) });

test('openWith: a command line splits on spaces and keeps quoted words whole', () => {
  assert.deepEqual(splitCommand('code -n {path}'), ['code', '-n', '{path}']);
  assert.deepEqual(splitCommand('"C:\\Program Files\\Ed\\ed.exe"  --wait  \'{path}\''), ['C:\\Program Files\\Ed\\ed.exe', '--wait', '{path}']);
  assert.deepEqual(splitCommand('ed ""'), ['ed', '']);
  assert.deepEqual(splitCommand('   '), []);
});

test('openWith: the program of a command is named without folder and extension', () => {
  assert.equal(commandName('"C:\\Tools\\subl.exe" {path}'), 'subl');
  assert.equal(commandName('/usr/local/bin/code-insiders -n'), 'code-insiders');
  assert.equal(commandName('zed.cmd'), 'zed');
  assert.equal(commandName(''), '');
});

test('openWith: {path} is filled in, or the folder goes at the end when the command has none', () => {
  assert.deepEqual(fillPath(['code', '-n', '{path}'], 'D:\\w'), ['code', '-n', 'D:\\w']);
  assert.deepEqual(fillPath(['ed', '--dir={path}'], '/w'), ['ed', '--dir=/w']);
  assert.deepEqual(fillPath(['subl', '-a'], '/w'), ['subl', '-a', '/w']);
});

test('openWith: a preset opens with its program when it is on the PATH', () => {
  assert.deepEqual(editorLaunch('vscode', '', '/w', 'win32', has(['code'])), { file: 'code', args: ['/w'] });
  assert.deepEqual(editorLaunch('idea', '', '/w', 'linux', has(['idea'])), { file: 'idea', args: ['/w'] });
});

test('openWith: on macOS a preset without its program falls back to open -a with its app', () => {
  assert.deepEqual(editorLaunch('vscode', '', '/w', 'darwin', has([], ['Visual Studio Code'])), { file: 'open', args: ['-a', 'Visual Studio Code', '/w'] });
  assert.deepEqual(editorLaunch('idea', '', '/w', 'darwin', has([], ['IntelliJ IDEA CE'])), { file: 'open', args: ['-a', 'IntelliJ IDEA CE', '/w'] });
});

test('openWith: a preset that is not there has no launch, and macOS apps do not count elsewhere', () => {
  assert.equal(editorLaunch('cursor', '', '/w', 'darwin', has([])), null);
  assert.equal(editorLaunch('vscode', '', '/w', 'win32', has([], ['Visual Studio Code'])), null);
});

test('openWith: a custom command needs its program on the PATH', () => {
  assert.deepEqual(editorLaunch('custom', 'code-insiders -n {path}', 'D:\\w', 'win32', has(['code-insiders'])), { file: 'code-insiders', args: ['-n', 'D:\\w'] });
  assert.equal(editorLaunch('custom', 'zed {path}', '/w', 'linux', has([])), null);
  assert.equal(editorLaunch('custom', '', '/w', 'linux', has(['code'])), null);
});

test('openWith: each terminal opens a shell in the folder, with a fallback when its program is missing', () => {
  assert.deepEqual(terminalLaunch('wt', 'D:\\w', 'win32', has(['wt'])), { file: 'wt', args: ['-d', 'D:\\w'] });
  assert.deepEqual(terminalLaunch('wt', 'D:\\w', 'win32', has([])), { file: 'powershell.exe', args: ['-NoExit'], cwd: 'D:\\w' });
  assert.equal(terminalLaunch('powershell', 'D:\\w', 'win32', has(['pwsh'])).file, 'pwsh.exe');
  assert.equal(terminalLaunch('powershell', 'D:\\w', 'win32', has([])).file, 'powershell.exe');
  assert.deepEqual(terminalLaunch('cmd', 'D:\\w', 'win32', has([])), { file: 'cmd.exe', args: [], cwd: 'D:\\w' });
  assert.deepEqual(terminalLaunch('terminal', '/w', 'darwin', has([])), { file: 'open', args: ['-a', 'Terminal', '/w'] });
  assert.deepEqual(terminalLaunch('iterm', '/w', 'darwin', has([])), { file: 'open', args: ['-a', 'iTerm', '/w'] });
  assert.deepEqual(terminalLaunch('x-terminal', '/w', 'linux', has(['x-terminal-emulator'])), { file: 'x-terminal-emulator', args: [], cwd: '/w' });
  assert.deepEqual(terminalLaunch('x-terminal', '/w', 'linux', has([])), { file: 'gnome-terminal', args: ['--working-directory=/w'] });
});

test('openWith: each OS offers its own terminals, the usual one first', () => {
  assert.deepEqual(terminalsFor('win32').map((x) => x.id), ['wt', 'powershell', 'cmd']);
  assert.deepEqual(terminalsFor('darwin').map((x) => x.id), ['terminal', 'iterm']);
  assert.deepEqual(terminalsFor('linux').map((x) => x.id), ['x-terminal']);
});

test('openWith: saved values outside the lists fall back to the defaults', () => {
  assert.equal(cleanEditor('cursor'), 'cursor');
  assert.equal(cleanEditor('custom'), 'custom');
  assert.equal(cleanEditor('emacs'), 'vscode');
  assert.equal(cleanTerminal('iterm', 'darwin'), 'iterm');
  assert.equal(cleanTerminal('iterm', 'win32'), 'wt');
  assert.equal(cleanEditorCmd('  code -n {path} '), 'code -n {path}');
  assert.equal(cleanEditorCmd(42), '');
  assert.equal(cleanEditorCmd('x'.repeat(900)).length, 500);
});

test('openWith: a custom editor is named and badged by its program', () => {
  assert.deepEqual(editorLabel('vscode', ''), { name: 'VS Code', badge: 'VS' });
  assert.deepEqual(editorLabel('custom', 'subl -n {path}'), { name: 'subl', badge: 'Su' });
  assert.deepEqual(editorLabel('custom', ''), { name: 'Editor', badge: '··' });
  assert.equal(editorProgram('idea', ''), 'idea');
  assert.equal(editorProgram('custom', '"C:\\x\\zed.exe" {path}'), 'zed');
  assert.equal(presetTemplate('cursor'), 'cursor {path}');
});

test('openWith: the menu lists the default and the editors found, presets in their order, a custom default first', () => {
  const ids = (def: Parameters<typeof menuEditors>[0], found: Parameters<typeof menuEditors>[2], custom = '') => menuEditors(def, custom, found).map((e) => `${e.id}${e.ok ? '' : '!'}`);
  assert.deepEqual(ids('vscode', { vscode: true, cursor: true, idea: true }), ['vscode', 'cursor', 'idea']);
  assert.deepEqual(ids('cursor', { vscode: true }), ['vscode', 'cursor!']);
  assert.deepEqual(ids('custom', { idea: true, custom: true }, 'zed {path}'), ['custom', 'idea']);
});

test('openWith: a batch file command line is quoted for cmd.exe', () => {
  assert.equal(cmdLine('C:\\VS Code\\bin\\code.cmd', ['D:\\w']), '""C:\\VS Code\\bin\\code.cmd" D:\\w"');
  assert.equal(cmdLine('code.cmd', ['D:\\my work & co']), '"code.cmd "D:\\my work & co""');
});
