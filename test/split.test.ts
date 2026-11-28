import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closePane, dropGone, onePerPane, openBeside, panesFit, PANES_MIN, restorePair, swapPanes, toggleBeside, type Panes } from '../src/shared/split';
import { restoreScreen } from '../src/shared/history';
import { Drafts } from '../src/shared/drafts';

const one: Panes = { wSel: 'W-01', wTab: 'changes', pair: null };
const two: Panes = { wSel: 'W-02', wTab: 'chat', pair: { id: 'W-01', tab: 'changes', left: true } };

test('split: two panes only in a window as wide as the right sidebar needs to stay a column', () => {
  assert.equal(panesFit(PANES_MIN), true);
  assert.equal(panesFit(PANES_MIN - 1), false);
});

test('split: open beside puts the Worker on the right of a single pane and selects it', () => {
  assert.deepEqual(openBeside(one, 'W-02'), two);
  assert.deepEqual(openBeside({ wSel: null, wTab: 'summary', pair: null }, 'W-02'), { wSel: 'W-02', wTab: 'chat', pair: null });
  assert.equal(openBeside(one, 'W-01'), one);
});

test('split: open beside with two panes replaces the other one, and selects a Worker already shown', () => {
  assert.deepEqual(openBeside(two, 'W-03'), { wSel: 'W-03', wTab: 'chat', pair: { id: 'W-02', tab: 'chat', left: false } });
  assert.deepEqual(openBeside(two, 'W-01'), swapPanes(two));
});

test('split: F6 selects the other pane and each Worker keeps its side and tab', () => {
  assert.deepEqual(swapPanes(two), { wSel: 'W-01', wTab: 'changes', pair: { id: 'W-02', tab: 'chat', left: false } });
  assert.deepEqual(swapPanes(swapPanes(two)), two);
  assert.equal(swapPanes(one), one);
});

test('split: a Worker opened the usual way goes into the selected pane, never into both', () => {
  assert.deepEqual(onePerPane(two, { ...two, wSel: 'W-03' }), { ...two, wSel: 'W-03' });
  assert.deepEqual(onePerPane(two, { ...two, wSel: 'W-01' }), swapPanes(two));
  assert.deepEqual(onePerPane(two, { ...two, wSel: 'W-01', wTab: 'summary' }), { ...swapPanes(two), wTab: 'summary' });
  assert.deepEqual(onePerPane({ ...two, wSel: null }, { ...two, wSel: 'W-01' }), { ...two, wSel: 'W-01', pair: null });
});

test('split: closing a pane leaves the other one alone', () => {
  assert.deepEqual(closePane(two, 'pair'), { wSel: 'W-02', wTab: 'chat', pair: null });
  assert.deepEqual(closePane(two, 'sel'), { wSel: 'W-01', wTab: 'changes', pair: null });
  assert.equal(closePane(one, 'sel'), one);
});

test('split: Ctrl+\\ closes the other pane, or opens beside the last active other Worker, live ones first', () => {
  const order = [{ id: 'W-09', archived: true }, { id: 'W-01', archived: false }, { id: 'W-04', archived: false }];
  assert.deepEqual(toggleBeside(two, order), closePane(two, 'pair'));
  assert.deepEqual(toggleBeside(one, order), openBeside(one, 'W-04'));
  assert.deepEqual(toggleBeside(one, [{ id: 'W-01', archived: false }, { id: 'W-09', archived: true }]), openBeside(one, 'W-09'));
  assert.equal(toggleBeside(one, [{ id: 'W-01', archived: false }]), null);
});

test('split: a gone Worker closes its pane', () => {
  assert.deepEqual(dropGone(two, (id) => id !== 'W-01'), { ...two, pair: null });
  assert.deepEqual(dropGone(two, (id) => id !== 'W-02'), { wSel: 'W-01', wTab: 'changes', pair: null });
  assert.equal(dropGone(two, () => true), two);
});

test('split: the pair comes back at the next start unless a Worker is gone or archived', () => {
  const there = { worker: (id: string) => id !== 'W-07', archived: (id: string) => id === 'W-08' };
  assert.deepEqual(restorePair({ id: 'W-01', tab: 'nope', left: true }, 'W-02', there), { id: 'W-01', tab: 'chat', left: true });
  assert.equal(restorePair({ id: 'W-07', tab: 'chat', left: true }, 'W-02', there), null);
  assert.equal(restorePair({ id: 'W-08', tab: 'chat', left: true }, 'W-02', there), null);
  assert.equal(restorePair({ id: 'W-01', tab: 'chat', left: true }, 'W-08', there), null);
  assert.equal(restorePair({ id: 'W-02' }, 'W-02', there), null);
  assert.equal(restorePair('W-01', 'W-02', there), null);
});

test('split: the last screen keeps its pair only with the conversation open', () => {
  const there = { worker: () => true, repo: () => true, archived: (id: string) => id === 'W-03' };
  const saved = { view: 'worker', wSel: 'W-02', wOpen: true, wTab: 'chat', pair: { id: 'W-01', tab: 'summary', left: true } };
  assert.deepEqual(restoreScreen(saved, there)?.pair, { id: 'W-01', tab: 'summary', left: true });
  assert.equal(restoreScreen({ ...saved, wOpen: false }, there)?.pair, null);
  assert.equal(restoreScreen({ ...saved, wSel: 'W-03' }, there)?.pair, null);
});

test('drafts: the other pane shows its Worker\'s draft without taking it', () => {
  const d = new Drafts<null>();
  d.put('W-01', { text: 'half a sentence', files: [], reply: null });
  assert.equal(d.peek('W-01')?.text, 'half a sentence');
  assert.equal(d.has('W-01'), true);
  assert.equal(d.peek('W-02'), null);
});
