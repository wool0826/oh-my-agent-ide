import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HELD_DROP, HELD_RUN, answersByReply, decisionButtons, readPress, remoteChoices, settledLine, shownAnswer,
} from '../src/shared/remoteDecision';
import { fromOwner } from '../src/shared/remote';
import type { Say } from '../src/shared/askWhy';

const say: Say = (k) => k;
const opts = (...l: string[]) => l.map((label) => ({ label }));

test('remoteDecision: a permission has no buttons and is not answered by a reply', () => {
  assert.deepEqual(remoteChoices(say, { source: 'permission', options: [] }), []);
  assert.equal(answersByReply({ source: 'permission' }), false);
  assert.equal(answersByReply({ source: 'question' }), true);
});

test('remoteDecision: a plan is approved or denied', () => {
  assert.deepEqual(remoteChoices(say, { source: 'plan', options: opts('allow') }), [{ label: 'plan.approve', answer: 'allow' }, { label: 'deny', answer: 'deny' }]);
});

test('remoteDecision: a question offers its options as the OS notification would: few, short, nothing to read first', () => {
  assert.deepEqual(remoteChoices(say, { source: 'question', options: opts('Left', 'Right') }), [{ label: 'Left', answer: 'Left' }, { label: 'Right', answer: 'Right' }]);
  assert.deepEqual(remoteChoices(say, { source: 'dispatcher', options: opts('A', 'B', 'C', 'D') }), []);
  assert.deepEqual(remoteChoices(say, { source: 'question', options: [{ label: 'A', description: 'why' }, { label: 'B' }] }), []);
});

test('remoteDecision: a button carries the decision and the choice in at most 64 bytes, and reads back', () => {
  const id = '6f1c2b0e-8d3a-4c1e-9f7a-0b1c2d3e4f5a';
  const rows = decisionButtons(id, [{ label: 'Yes', answer: 'Yes' }, { label: 'No', answer: 'No' }]);
  assert.deepEqual(rows[0].map((b) => b.data), [`d:${id}:0`, `d:${id}:1`]);
  for (const b of rows[0]) assert.ok(Buffer.byteLength(b.data) <= 64);
  assert.deepEqual(readPress(rows[0][1].data), { kind: 'decision', id, n: 1 });
  assert.deepEqual(decisionButtons(id, []), []);
});

test('remoteDecision: held-message buttons read back; anything else is nothing', () => {
  assert.deepEqual(readPress(HELD_RUN), { kind: 'held', run: true });
  assert.deepEqual(readPress(HELD_DROP), { kind: 'held', run: false });
  for (const x of [undefined, '', 'd:', 'd:abc', 'd:abc:x', 'd:a b:1', 'x:abc:1']) assert.equal(readPress(x), null);
});

test('remoteDecision: answers read as the app names them, and the line that replaces the buttons', () => {
  assert.equal(shownAnswer(say, { source: 'plan' }, 'allow'), 'plan.approve');
  assert.equal(shownAnswer(say, { source: 'permission' }, 'allow'), 'allow');
  assert.equal(shownAnswer(say, { source: 'permission' }, 'allow-task'), 'allowTask');
  assert.equal(shownAnswer(say, { source: 'question' }, 'deny'), 'deny');
  assert.equal(shownAnswer(say, { source: 'question' }, 'Postgres'), 'Postgres');
  assert.equal(settledLine(say, 'Use\n  Postgres'), '→ Use Postgres');
  assert.equal(settledLine(say, null), 'tg.d.withdrawn');
});

test('remoteDecision: only the owner pressing in their private chat counts', () => {
  const cb = (from: number, chat: number, type = 'private') => ({ update_id: 1, callback_query: { id: 'c', from: { id: from }, message: { message_id: 5, chat: { id: chat, type } }, data: 'd:x:0' } });
  assert.equal(fromOwner(cb(42, 42), 42), true);
  assert.equal(fromOwner(cb(777, 42), 42), false);
  assert.equal(fromOwner(cb(42, -42, 'group'), 42), false);
  assert.equal(fromOwner({ update_id: 1, callback_query: { id: 'c', from: { id: 42 } } }, 42), false);
  assert.equal(fromOwner(cb(42, 42), null), false);
});
