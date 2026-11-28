import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ECHO_MS, HISTORY_MAX, History, NavInput, restoreScreen, sameScreen, type Screen } from '../src/shared/history';

function scr(patch: Partial<Screen> = {}): Screen {
  return { view: 'chat', wSel: null, wOpen: false, wTab: 'chat', repoSel: null, memSel: null, wFilter: null, ...patch };
}

const chat = scr();
const list = scr({ view: 'worker' });
const conv = (id: string) => scr({ view: 'worker', wSel: id, wOpen: true });

test('history: back and forward retrace the screens in order', () => {
  const h = new History<Screen>(sameScreen);
  assert.equal(h.push(chat, list), true);
  assert.equal(h.push(list, conv('W-01')), true);
  assert.deepEqual(h.goBack(conv('W-01')), list);
  assert.deepEqual(h.goBack(list), chat);
  assert.equal(h.goBack(chat), null);
  assert.deepEqual(h.goForward(chat), list);
  assert.deepEqual(h.goForward(list), conv('W-01'));
  assert.equal(h.goForward(conv('W-01')), null);
});

test('history: moving to the screen already shown records nothing', () => {
  const h = new History<Screen>(sameScreen);
  assert.equal(h.push(chat, scr()), false);
  assert.equal(h.back.length, 0);
});

test('history: the current screen is not pushed twice in a row', () => {
  const h = new History<Screen>(sameScreen);
  h.push(chat, list);
  // The window got back to the chat without a navigation (for example a removed repository was deselected).
  h.push(chat, conv('W-01'));
  assert.equal(h.back.length, 1);
  assert.deepEqual(h.goBack(conv('W-01')), chat);
});

test('history: a new navigation drops the forward entries', () => {
  const h = new History<Screen>(sameScreen);
  h.push(chat, list);
  h.push(list, conv('W-01'));
  h.goBack(conv('W-01'));
  assert.equal(h.forward.length, 1);
  h.push(list, scr({ view: 'repo' }));
  assert.equal(h.forward.length, 0);
  assert.equal(h.goForward(scr({ view: 'repo' })), null);
});

test('history: keeps at most HISTORY_MAX entries, dropping the oldest', () => {
  const h = new History<Screen>(sameScreen);
  let cur = conv('W-0');
  for (let i = 1; i <= HISTORY_MAX + 10; i++) {
    const next = conv(`W-${i}`);
    h.push(cur, next);
    cur = next;
  }
  assert.equal(h.back.length, HISTORY_MAX);
  assert.deepEqual(h.back[0], conv('W-10'));
  // Going all the way back ends at the oldest kept entry, and the forward side stays within the cap.
  let s: Screen | null;
  while ((s = h.goBack(cur))) cur = s;
  assert.deepEqual(cur, conv('W-10'));
  assert.equal(h.forward.length, HISTORY_MAX);
});

test('history: skips entries the check drops, and ones that now match the current screen', () => {
  const h = new History<Screen>(sameScreen);
  h.push(chat, conv('W-01'));
  h.push(conv('W-01'), conv('W-02'));
  h.push(conv('W-02'), list);
  // W-02 is gone: its conversation is dropped and Back lands on W-01.
  const gone = new Set(['W-02']);
  const check = (s: Screen) => (s.wSel && gone.has(s.wSel) ? null : s);
  assert.deepEqual(h.goBack(list, check), conv('W-01'));
  assert.deepEqual(h.forward, [list]);
  // An entry that the check turns into the current screen is skipped as well.
  const h2 = new History<Screen>(sameScreen);
  h2.push(chat, conv('W-03'));
  h2.push(conv('W-03'), list);
  const toList = (s: Screen) => (s.wSel === 'W-03' ? { ...s, wSel: null, wOpen: false } : s);
  assert.deepEqual(h2.goBack(list, toList), chat);
});

test('history: nothing left after dropping stale entries leaves the screen as it is', () => {
  const h = new History<Screen>(sameScreen);
  h.push(conv('W-09'), chat);
  assert.equal(h.goBack(chat, () => null), null);
  assert.equal(h.forward.length, 0);
});

test('history: screens differ by any field, filter included', () => {
  assert.equal(sameScreen(list, scr({ view: 'worker' })), true);
  assert.equal(sameScreen(list, scr({ view: 'worker', wFilter: 'today' })), false);
  assert.equal(sameScreen(conv('W-01'), { ...conv('W-01'), wTab: 'changes' }), false);
});

test('nav input: the same press from a second source is an echo', () => {
  const n = new NavInput();
  assert.equal(n.accept('mouse', 'back', 1000), true);
  assert.equal(n.accept('os', 'back', 1000 + 20), false);
  // Either order.
  const m = new NavInput();
  assert.equal(m.accept('os', 'back', 0), true);
  assert.equal(m.accept('mouse', 'back', 5), false);
});

test('nav input: a fast double click steps twice', () => {
  const n = new NavInput();
  const got = [n.accept('mouse', 'back', 0), n.accept('os', 'back', 2), n.accept('mouse', 'back', 150), n.accept('os', 'back', 152)];
  assert.deepEqual(got, [true, false, true, false]);
});

test('nav input: another source counts after the echo window or in the other direction', () => {
  const n = new NavInput();
  assert.equal(n.accept('mouse', 'back', 0), true);
  assert.equal(n.accept('os', 'forward', 10), true);
  assert.equal(n.accept('key', 'forward', 10 + ECHO_MS), true);
});

test('history: the last screen comes back with what is still there', () => {
  const there = { worker: (id: string) => id === 'W-05', repo: (n: string) => n === 'app' };
  assert.deepEqual(restoreScreen(conv('W-05'), there), conv('W-05'));
  assert.deepEqual(restoreScreen(scr({ view: 'repo', repoSel: 'app', memSel: 'm.md' }), there), scr({ view: 'repo', repoSel: 'app', memSel: 'm.md' }));
});

test('history: a gone Worker or repository is deselected in the last screen', () => {
  const there = { worker: () => false, repo: () => false };
  assert.deepEqual(restoreScreen({ ...conv('W-09'), wTab: 'changes', wFilter: 'archived' }, there), scr({ view: 'worker', wTab: 'changes', wFilter: 'archived' }));
  assert.deepEqual(restoreScreen(scr({ view: 'repo', repoSel: 'old' }), there), scr({ view: 'repo' }));
});

test('history: a kept screen that is not one is ignored', () => {
  const there = { worker: () => true, repo: () => true };
  assert.equal(restoreScreen(null, there), null);
  assert.equal(restoreScreen({ view: 'board' }, there), null);
  assert.deepEqual(restoreScreen({ view: 'worker', wTab: 'x', wOpen: 'yes' }, there), scr({ view: 'worker' }));
});
