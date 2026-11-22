import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchItems, stepIndex } from '../src/shared/palette';

const items = [
  { id: 'chat', title: 'Chat', group: 'go' },
  { id: 'set', title: 'Settings', group: 'go' },
  { id: 'w1', title: 'W-01 Fix the usage bar', hint: 'oh-my-agent-ide · Opus 5.5', group: 'worker' },
  { id: 'w2', title: 'W-02 사용량 막대 색 맞추기', hint: 'memory · GPT-6-Luna', group: 'worker' },
  { id: 'repo', title: 'oh-my-agent-ide', hint: 'Repository', group: 'repo' },
];
const ids = (q: string, limit?: number) => matchItems(items, q, limit).map((x) => x.id);

test('nothing typed gives the list as it is, up to the limit', () => {
  assert.deepEqual(ids(''), ['chat', 'set', 'w1', 'w2', 'repo']);
  assert.deepEqual(ids('   ', 2), ['chat', 'set']);
});

test('a title that starts with the word comes before one that has it later, then a hint', () => {
  assert.deepEqual(ids('oh'), ['repo', 'w1']);
  assert.deepEqual(ids('usage'), ['w1']);
  assert.deepEqual(ids('opus'), ['w1']);
});

test('every word has to match, in the title or the hint, in any case', () => {
  assert.deepEqual(ids('w-0 LUNA'), ['w2']);
  assert.deepEqual(ids('fix luna'), []);
});

test('Korean matches by the letters typed', () => {
  assert.deepEqual(ids('막대'), ['w2']);
});

test('the highlight goes round at the ends', () => {
  assert.equal(stepIndex(0, -1, 3), 2);
  assert.equal(stepIndex(2, 1, 3), 0);
  assert.equal(stepIndex(1, 1, 3), 2);
  assert.equal(stepIndex(0, 1, 0), 0);
});
