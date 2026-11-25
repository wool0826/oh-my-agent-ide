// Replies under a Worker's report in the chat (shared/thread.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replyThreads, threadLayout, threadOpen, turnReplyTo, type ThreadItem } from '../src/shared/thread';

const card = (id: string): ThreadItem => ({ kind: 'result', ref: id });
const fail = (id: string): ThreadItem => ({ kind: 'error', ref: id });
const ai = (replyTo?: string): ThreadItem => ({ kind: 'dispatcher', replyTo });
const me = (replyTo?: string): ThreadItem => ({ kind: 'user', replyTo });
const shape = (items: ThreadItem[]) => threadLayout(items).map((s) => (s.depth ? `${s.late ? 'late' : s.start ? 'start' : 'in'}:${s.root}` : '-'));

test('replies right after their card sit one step in, in one group that opens at the first', () => {
  assert.deepEqual(shape([card('T-1'), ai('T-1'), me('T-1'), ai('T-1'), card('T-2'), ai('T-2')]),
    ['-', 'start:T-1', 'in:T-1', 'in:T-1', '-', 'start:T-2']);
});

test('a failure card is a report too', () => {
  assert.deepEqual(shape([fail('T-1'), ai('T-1')]), ['-', 'start:T-1']);
});

test('a reply that comes after other messages keeps its place in time, as a late group that names the report', () => {
  assert.deepEqual(shape([card('T-1'), ai('T-1'), ai(), me('T-1'), ai('T-1'), card('T-2'), ai('T-1')]),
    ['-', 'start:T-1', '-', 'late:T-1', 'in:T-1', '-', 'late:T-1']);
});

test('a reply to a report that is not in the list, a plain message, or an error line without a task draw as today', () => {
  assert.deepEqual(shape([ai('T-9'), me(), { kind: 'error' }, ai()]), ['-', '-', '-', '-']);
  // A line with no task between a card and its reply ends the group.
  assert.deepEqual(shape([card('T-1'), { kind: 'event' }, ai('T-1')]), ['-', '-', 'late:T-1']);
});

test('never deeper than one step: a reply after a reply stays at the same step', () => {
  const slots = threadLayout([card('T-1'), ai('T-1'), me('T-1'), me('T-1'), ai('T-1')]);
  assert.ok(slots.every((s) => s.depth <= 1));
  assert.deepEqual(slots.map((s) => s.depth), [0, 1, 1, 1, 1]);
});

test('a turn answers a report only when exactly one report started it', () => {
  assert.equal(turnReplyTo(['T-1']), 'T-1');
  assert.equal(turnReplyTo(['T-1', 'T-1']), 'T-1');
  assert.equal(turnReplyTo(['T-1', 'T-2']), null);
  assert.equal(turnReplyTo([]), null);
});

test('a reply to the earlier of two reports back to back is late, under its own chip', () => {
  assert.deepEqual(shape([card('T-1'), card('T-2'), me('T-1'), ai('T-1'), ai('T-2')]), ['-', '-', 'late:T-1', 'in:T-1', 'late:T-2']);
});

/** Each thread as its first index, card kind and rows, with ids `c0`, `c1`… by position. */
const threads = (items: ThreadItem[]) => [...replyThreads(items.map((_, i) => ({ id: `c${i}` })), threadLayout(items))].map(([at, g]) => [at, g.late ? 'late' : 'under', g.root, g.rows.join(','), g.key].join(' '));

test('a thread is the replies to one report in a row: under its card, or a later card of its own', () => {
  assert.deepEqual(threads([card('T-1'), ai('T-1'), me('T-1'), ai(), me('T-1'), ai('T-1'), card('T-2'), ai('T-2')]),
    ['1 under T-1 1,2 c1', '4 late T-1 4,5 c4', '7 under T-2 7 c7']);
  // A late thread right after a card of another report is not that card's.
  assert.deepEqual(threads([card('T-1'), ai(), card('T-2'), me('T-1')]), ['3 late T-1 3 c3']);
  assert.deepEqual(threads([ai(), me()]), []);
});

test('only the newest thread is open by default; what the user opened or folded stays so', () => {
  const set = new Map<string, boolean>();
  assert.equal(threadOpen('c4', 'c4', set), true);
  assert.equal(threadOpen('c1', 'c4', set), false);
  set.set('c1', true).set('c4', false);
  assert.equal(threadOpen('c1', 'c4', set), true);
  assert.equal(threadOpen('c4', 'c4', set), false);
  // A newer thread arrives: the one folded by default folds, the ones the user set keep their state.
  assert.equal(threadOpen('c7', 'c7', set), true);
  assert.equal(threadOpen('c1', 'c7', set), true);
});
