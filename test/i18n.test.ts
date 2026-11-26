import { test } from 'node:test';
import assert from 'node:assert/strict';
import { areas, tr } from '../src/shared/i18n';

test('a count picks the singular or the plural word in English, and Korean has one form', () => {
  assert.equal(tr('en', 'toast.cancelled', { n: 1 }), 'Cancelled 1 task.');
  assert.equal(tr('en', 'toast.cancelled', { n: 2 }), 'Cancelled 2 tasks.');
  assert.equal(tr('en', 'toast.cancelled', { n: 0 }), 'Cancelled 0 tasks.');
  assert.equal(tr('en', 'ins.busy', { n: 1 }), '1 Worker at work');
  assert.equal(tr('en', 'ins.busy', { n: 3 }), '3 Workers at work');
  assert.equal(tr('en', 'st.subagents', { n: '1' }), 'Waiting for 1 subagent to report');
  assert.equal(tr('ko', 'toast.cancelled', { n: 1 }), '작업 1개를 취소했어요.');
  assert.equal(tr('ko', 'toast.cancelled', { n: 2 }), '작업 2개를 취소했어요.');
});

test('the verb follows the count too, and values keep their place beside it', () => {
  assert.equal(tr('en', 'wk.nAsk', { n: 1 }), '1 needs your decision');
  assert.equal(tr('en', 'wk.nAsk', { n: 4 }), '4 need your decision');
  assert.equal(tr('en', 'ev.reviewing', { id: 'W-02', n: 1, title: 'Fix {n} things' }), 'W-02 is addressing 1 review comment on Fix {n} things');
});

test('a value that was not given leaves its place as written', () => {
  assert.equal(tr('en', 'toast.cancelled'), 'Cancelled {n} {n|task|tasks}.');
  assert.equal(tr('en', 'toast.cancelled', {}), 'Cancelled {n} {n|task|tasks}.');
});

test('one name for a decision that waits, wherever it is said', () => {
  for (const key of ['task.waiting', 'st.waitingMe', 'ins.decisions', 'side.decisions'] as const) {
    assert.equal(tr('en', key), 'Needs your decision', key);
    assert.equal(tr('ko', key), '결정 필요', key);
  }
});

test('a key lives in one area, and each area has Korean for exactly its English keys', () => {
  const seen = new Map<string, string>();
  for (const [name, area] of Object.entries(areas)) {
    for (const key of Object.keys(area.en)) {
      assert.equal(seen.get(key), undefined, `${key} is in ${seen.get(key)} and ${name}`);
      seen.set(key, name);
    }
    assert.deepEqual(Object.keys(area.ko).sort(), Object.keys(area.en).sort(), name);
  }
});
