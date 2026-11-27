// The card over a running task in the left sidebar (shared/runCard.ts) and where it sits (shared/tip.ts, cardPlace).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCard } from '../src/shared/runCard';
import { cardPlace } from '../src/shared/tip';
import type { Task, Worker } from '../src/shared/types';

const AT = '2026-11-27T10:00:00Z';
const T = (over: Partial<Task> = {}) => ({ id: 'T-0149', title: 'Fix the swipe e2e on macOS', status: 'running', steps: null, branch: null, prUrl: null, createdAt: AT, startedAt: null, ...over }) as Task;
const W = (over: Partial<Worker> = {}) => ({ id: 'W-03', statusText: '', ...over }) as Worker;
const steps = (titles: string[], done: number) => titles.map((title, i) => ({ title, doneAt: i < done ? AT : null }));

test('runCard: a one-line title with its branch and PR', () => {
  const c = runCard(T({ steps: steps(['Reproduce', 'Fix the wait', 'Run e2e', 'Open PR'], 2), branch: 'fix/swipe-e2e-mac', prUrl: 'https://github.com/o/r/pull/212', startedAt: '2026-11-27T10:05:00Z' }), W({ statusText: 'gh pr checks 212 --watch' }));
  assert.deepEqual(c, {
    task: 'T-0149', worker: 'W-03', since: '2026-11-27T10:05:00Z', title: 'Fix the swipe e2e on macOS', at: 2, total: 4,
    steps: [{ title: 'Reproduce', state: 'done' }, { title: 'Fix the wait', state: 'done' }, { title: 'Run e2e', state: 'cur' }, { title: 'Open PR', state: 'todo' }],
    now: 'gh pr checks 212 --watch', branch: 'fix/swipe-e2e-mac', pr: '#212', err: false,
  });
});

test('runCard: a long title is kept whole, with no branch, PR or steps', () => {
  const title = 'UI/UX mock-up: script copy, running tooltip, Settings status, token switch-off and the left sidebar moved below a top strip';
  const c = runCard(T({ title: `  ${title} ` }), W());
  assert.equal(c.title, title);
  assert.equal(c.since, AT);
  assert.deepEqual([c.at, c.total, c.steps, c.now, c.branch, c.pr, c.err], [0, 0, [], '', '', '', false]);
});

test('runCard: stopped by an error, it says what stopped it at the current step', () => {
  const c = runCard(T({ steps: steps(['Read layout', 'Fix padding', 'Unit tests'], 1) }), W({ statusText: 'Bash' }), 'exit 1 · test/e2e/lights.e2e.mjs');
  assert.equal(c.err, true);
  assert.equal(c.now, 'exit 1 · test/e2e/lights.e2e.mjs');
  assert.equal(c.steps[1].state, 'cur');
});

test('runCard: all steps done counts every one done', () => {
  const c = runCard(T({ steps: steps(['A', 'B'], 2) }), W());
  assert.deepEqual([c.at, c.total], [2, 2]);
  assert.ok(c.steps.every((s) => s.state === 'done'));
});

const box = (left: number, top: number, width: number, height = 44) => ({ left, top, width, height });

test('cardPlace: beside the sidebar on the right, level with the row', () => {
  assert.deepEqual(cardPlace(box(20, 120, 252), 296, 300, 1320, 900), { left: 278, top: 120, side: 'right' });
});

test('cardPlace: moved up to stay in the window', () => {
  assert.equal(cardPlace(box(20, 800, 252), 296, 300, 1320, 900).top, 592);
});

test('cardPlace: next to a collapsed rail in a narrow window, still inside it', () => {
  const p = cardPlace(box(16, 20, 36, 36), 296, 190, 760, 700);
  assert.deepEqual(p, { left: 58, top: 20, side: 'right' });
  assert.ok(p.left + 296 <= 760 - 8);
});

test('cardPlace: on the left when the right has no room, else below the row', () => {
  assert.equal(cardPlace(box(700, 100, 200), 296, 200, 1000, 900).side, 'left');
  const p = cardPlace(box(10, 100, 300), 296, 200, 340, 900);
  assert.equal(p.side, 'below');
  assert.ok(p.left >= 8 && p.left + 296 <= 340 - 8 + 1);
});
