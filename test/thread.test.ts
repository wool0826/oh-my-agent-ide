// Replies under a Worker's report in the chat (shared/thread.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { threadLayout, turnReplyTo, type ThreadItem } from '../src/shared/thread';

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
