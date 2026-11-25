// The side terminal (shared/terminal.ts, main/terminal.ts): what is kept of its runs and history, the panel's size,
// and a line that runs there without becoming a chat item or going to the Dispatcher.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clampTermSize, keyTermSize, pushHistory, trimRuns, TERM_DEF, TERM_HISTORY, TERM_MIN, TERM_STEP, type TermRun, type TermView } from '../src/shared/terminal';
import { store } from '../src/main/store';
import { terminal } from '../src/main/terminal';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-term-'));
process.env.OMA_DATA_DIR = tmp;
const home = path.join(tmp, 'home');
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ home, language: 'en', claudeRules: false, claudeMemory: false, accounts: [] }));

const run = (id: string, running = false): TermRun => ({ id, cmd: id, repo: '', running, stopped: false, code: running ? null : 0, startedAt: '', ms: 0, out: '', lines: 0, sent: 'off' });

test('the oldest finished runs go past the limit; a run still going stays', () => {
  const runs = [run('a', true), run('b'), run('c'), run('d')];
  assert.deepEqual(trimRuns(runs, 2).map((r) => r.id), ['a', 'd']);
  assert.equal(trimRuns(runs, 9), runs);
  assert.deepEqual(trimRuns([run('a', true), run('b', true)], 1).map((r) => r.id), ['a', 'b']);
});

test('the history skips a repeat of the last line and keeps the newest', () => {
  assert.deepEqual(pushHistory(['ls'], ' ls '), ['ls']);
  assert.deepEqual(pushHistory(['ls'], '  '), ['ls']);
  assert.deepEqual(pushHistory(['ls', 'pwd'], 'ls'), ['ls', 'pwd', 'ls']);
  const many = Array.from({ length: TERM_HISTORY }, (_, i) => `l${i}`);
  const next = pushHistory(many, 'new');
  assert.equal(next.length, TERM_HISTORY);
  assert.deepEqual([next[0], next[next.length - 1]], ['l1', 'new']);
});

test('the panel keeps within its limits and the room it has', () => {
  const room = { w: 1000, h: 600 };
  assert.deepEqual(clampTermSize(700, 400.4, room), { w: 700, h: 400 });
  assert.deepEqual(clampTermSize(10, 10, room), TERM_MIN);
  assert.deepEqual(clampTermSize(5000, 5000, room), room);
  assert.deepEqual(clampTermSize(NaN, Infinity, room), TERM_DEF);
  // A window smaller than the least size: the least size.
  assert.deepEqual(clampTermSize(700, 400, { w: 100, h: 100 }), TERM_MIN);
});

test('a line runs in the terminal with its output, not in the chat; Clear keeps what still runs', async () => {
  store.load();
  const views: TermView[] = [];
  terminal.onChange((v) => views.push(v));
  assert.throws(() => terminal.run('  ', null), /Type a command/);
  assert.throws(() => terminal.run('echo x', 'nope'), /nope/);
  const chat = store.data.chat.length;
  const updates = store.data.pendingUpdates.length;
  const id = terminal.run('echo side-terminal', null);
  for (let i = 0; i < 100 && terminal.state().runs.find((r) => r.id === id)?.running; i++) await new Promise((r) => setTimeout(r, 50));
  const r = terminal.state().runs.find((x) => x.id === id)!;
  assert.equal(r.running, false);
  assert.equal(r.code, 0);
  assert.match(r.out, /side-terminal/);
  assert.equal(r.sent, 'off');
  assert.equal(store.data.chat.length, chat);
  assert.equal(store.data.pendingUpdates.length, updates);
  assert.ok(views.length >= 2);
  const slow = terminal.run(process.platform === 'win32' ? 'Start-Sleep 20' : 'sleep 20', null);
  terminal.clear();
  assert.deepEqual(terminal.state().runs.map((x) => x.id), [slow]);
  terminal.stop(slow);
  for (let i = 0; i < 100 && terminal.state().runs[0]?.running; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(terminal.state().runs[0].stopped, true);
  assert.equal(terminal.state().runs[0].code, null);
});

test('the edge handles: ↑ ↓ on the top one, → ← on the side one, Shift by four steps, within the room', () => {
  const room = { w: 1000, h: 600 };
  const now = { w: 560, h: 320 };
  assert.deepEqual(keyTermSize('h', 'ArrowUp', false, now, room), { w: 560, h: 320 + TERM_STEP });
  assert.deepEqual(keyTermSize('h', 'ArrowDown', true, now, room), { w: 560, h: 320 - 4 * TERM_STEP });
  assert.deepEqual(keyTermSize('w', 'ArrowRight', true, now, room), { w: 560 + 4 * TERM_STEP, h: 320 });
  assert.deepEqual(keyTermSize('w', 'ArrowLeft', false, { w: TERM_MIN.w + 4, h: 320 }, room), { w: TERM_MIN.w, h: 320 });
  assert.deepEqual(keyTermSize('w', 'ArrowRight', false, { w: 995, h: 320 }, room), { w: 1000, h: 320 });
  assert.equal(keyTermSize('h', 'ArrowLeft', false, now, room), null);
  assert.equal(keyTermSize('w', 'ArrowUp', false, now, room), null);
});
