// Replies under a Worker's report in the chat (shared/thread.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canRoot, lateReplies, replyThreads, threadIndex, threadLayout, threadOpen, threadTarget, turnReplyTo, type RootItem, type ThreadItem } from '../src/shared/thread';

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

// Threads as a panel (T-0076).
let n = 0;
const it = (kind: string, o: Partial<RootItem> = {}): RootItem => ({ id: o.id ?? `m${++n}`, kind, ...o });

test('a report or a Dispatcher message can be a root; the user, events and plain errors cannot', () => {
  assert.equal(canRoot(it('result', { ref: 'T-1' })), true);
  assert.equal(canRoot(it('error', { ref: 'T-1' })), true);
  assert.equal(canRoot(it('dispatcher')), true);
  assert.equal(canRoot(it('user')), false);
  assert.equal(canRoot(it('event')), false);
  assert.equal(canRoot(it('error')), false);
});

test('replies find their root by its id, or by task id for the report most recently above (saved replies)', () => {
  const items = [it('result', { ref: 'T-1' }), it('dispatcher', { replyTo: 'T-1' }), it('dispatcher', { id: 'd' }), it('user', { replyTo: 'd' }),
    it('result', { ref: 'T-1' }), it('dispatcher', { replyTo: 'T-1' }), it('user')];
  const ix = threadIndex(items);
  assert.deepEqual(ix.rootOf, [-1, 0, -1, 2, -1, 4, -1]);
  assert.deepEqual([...ix.replies], [[0, [1]], [2, [3]], [4, [5]]]);
});

test('a reply to a reply joins its root; one whose root is missing or no root stays in the chat', () => {
  const items = [it('dispatcher', { id: 'r' }), it('dispatcher', { id: 'a', replyTo: 'r' }), it('user', { replyTo: 'a' }), it('user', { id: 'u' }),
    it('dispatcher', { replyTo: 'u' }), it('dispatcher', { replyTo: 'gone' }), it('dispatcher', { replyTo: 'T-9' })];
  assert.deepEqual(threadIndex(items).rootOf, [-1, 0, 0, -1, -1, -1, -1]);
});

test('a thread whose newest reply came after other chat messages is marked where that reply is', () => {
  const items = [it('result', { ref: 'T-1' }), it('dispatcher', { replyTo: 'T-1' }), it('dispatcher', { id: 'x' }), it('user', { replyTo: 'x' }),
    it('user', { replyTo: 'T-1' })];
  // T-1's thread: its last reply (4) comes after the message x; x's thread is right under it, with only replies between.
  assert.deepEqual([...lateReplies(threadIndex(items))], [[4, 0]]);
  assert.deepEqual([...lateReplies(threadIndex(items.slice(0, 4)))], []);
});

test('a reply is filed under the root it names, the root of the reply it names, or a report task', () => {
  const chat = [it('result', { ref: 'T-1' }), it('dispatcher', { id: 'r' }), it('dispatcher', { id: 'a', replyTo: 'r' }), it('user', { id: 'u' }),
    it('dispatcher', { id: 'b', replyTo: 'T-1' })];
  assert.equal(threadTarget(chat, 'T-1'), 'T-1');
  assert.equal(threadTarget(chat, 'r'), 'r');
  assert.equal(threadTarget(chat, 'a'), 'r');
  assert.equal(threadTarget(chat, 'b'), 'T-1');
  assert.equal(threadTarget(chat, 'u'), null);
  assert.equal(threadTarget(chat, 'T-9'), null);
  assert.equal(threadTarget(chat, null), null);
  // A reply that names itself, or a gone root, is filed nowhere.
  assert.equal(threadTarget([it('dispatcher', { id: 'z', replyTo: 'z' })], 'z'), null);
  assert.equal(threadTarget([it('dispatcher', { id: 'y', replyTo: 'gone' })], 'y'), null);
});
