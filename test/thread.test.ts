// Reply threads in the chat (shared/thread.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canRoot, lateReplies, threadIndex, threadTarget, turnReplyTo, type RootItem } from '../src/shared/thread';

test('a turn answers a report only when exactly one report started it', () => {
  assert.equal(turnReplyTo(['T-1']), 'T-1');
  assert.equal(turnReplyTo(['T-1', 'T-1']), 'T-1');
  assert.equal(turnReplyTo(['T-1', 'T-2']), null);
  assert.equal(turnReplyTo([]), null);
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
  // A message whose own root is gone, or that names itself, is a root of its own.
  assert.equal(threadTarget([it('dispatcher', { id: 'z', replyTo: 'z' })], 'z'), 'z');
  assert.equal(threadTarget([it('dispatcher', { id: 'y', replyTo: 'gone' })], 'y'), 'y');
});

test('a task reported twice: a reply in the older card thread stays there, by the card id', () => {
  const chat = [it('result', { id: 'c1', ref: 'T-1' }), it('dispatcher', { id: 'a', replyTo: 'T-1' }), it('result', { id: 'c2', ref: 'T-1' }),
    it('dispatcher', { id: 'b', replyTo: 'T-1' })];
  assert.equal(threadTarget(chat, 'a'), 'c1');
  assert.equal(threadTarget(chat, 'c1'), 'c1');
  assert.equal(threadTarget(chat, 'b'), 'T-1');
  assert.equal(threadTarget(chat, 'c2'), 'T-1');
  const ix = threadIndex([...chat, it('user', { replyTo: 'c1' })]);
  assert.deepEqual([...ix.replies], [[0, [1, 4]], [2, [3]]]);
});

test('two threads whose replies interleave: each is marked late only when a chat message came between', () => {
  const items = [it('dispatcher', { id: 'p' }), it('dispatcher', { id: 'q' }), it('user', { replyTo: 'p' }), it('user', { replyTo: 'q' }), it('user', { replyTo: 'p' })];
  // q (a chat message) lies between p and its replies; only replies lie between q and its one.
  assert.deepEqual([...lateReplies(threadIndex(items))], [[4, 0]]);
  // A report that comes after the reply that names its task does not take it.
  assert.deepEqual(threadIndex([it('user', { replyTo: 'T-5' }), it('result', { ref: 'T-5' })]).rootOf, [-1, -1]);
});
