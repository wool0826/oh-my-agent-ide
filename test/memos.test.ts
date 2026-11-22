import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MEMO_MAX, cleanMemo, memoSections, sharedMemoDigest } from '../src/shared/memos';
import type { Memo } from '../src/shared/types';

const memo = (id: string, text: string, shared: boolean, at: string): Memo => ({ id, text, shared, createdAt: at, updatedAt: at });

test('memo text is trimmed, its line ends normalized, and cut at the limit', () => {
  assert.equal(cleanMemo('  check the mac build \r\n'), 'check the mac build');
  assert.equal(cleanMemo('a\r\nb\rc'), 'a\nb\nc');
  assert.equal(cleanMemo('   '), '');
  assert.equal(cleanMemo(undefined), '');
  assert.equal(cleanMemo('x'.repeat(MEMO_MAX + 50)).length, MEMO_MAX);
});

test('the sidebar lists shared memos and the user\'s own apart, newest first', () => {
  const s = memoSections([memo('a', 'old mine', false, '2026-11-20'), memo('b', 'shared', true, '2026-11-21'), memo('c', 'new mine', false, '2026-11-22')]);
  assert.deepEqual(s.shared.map((m) => m.id), ['b']);
  assert.deepEqual(s.mine.map((m) => m.id), ['c', 'a']);
});

test('only shared memos reach the Dispatcher, oldest first', () => {
  const memos = [memo('a', 'PR titles in English', true, '2026-11-21'), memo('b', 'private', false, '2026-11-20'), memo('c', 'Windows build first', true, '2026-11-20')];
  assert.equal(sharedMemoDigest(memos), '- Windows build first\n- PR titles in English');
  assert.equal(sharedMemoDigest([memo('b', 'private', false, '2026-11-20')]), '');
});

test('a memo of several lines stays one bullet', () => {
  assert.equal(sharedMemoDigest([memo('a', 'first\nsecond', true, '2026-11-21')]), '- first\n  second');
});

test('past the size limit the oldest shared memos are dropped', () => {
  const memos = [memo('a', 'a'.repeat(60), true, '2026-11-20'), memo('b', 'b'.repeat(60), true, '2026-11-21'), memo('c', 'c'.repeat(60), true, '2026-11-22')];
  const d = sharedMemoDigest(memos, 130);
  assert.ok(d.length <= 130);
  assert.doesNotMatch(d, /aaa/);
  assert.match(d, /bbb/);
  assert.match(d, /ccc/);
});
