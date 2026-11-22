import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchItems, searchWords, snippet, textMatches } from '../src/shared/textSearch';

test('every word has to be in the text, in any case and any order', () => {
  const w = searchWords('  Tax  ROUND ');
  assert.deepEqual(w, ['tax', 'round']);
  assert.equal(textMatches('We round the tax once.', w), true);
  assert.equal(textMatches('We round it once.', w), false);
  assert.equal(textMatches('anything', []), false);
  assert.equal(textMatches('세금을 한 번만 반올림합니다', searchWords('반올림 세금')), true);
});

test('the snippet is one line around the first word found', () => {
  const text = `${'a '.repeat(60)}the tax is\nrounded twice ${'b '.repeat(60)}`;
  const s = snippet(text, ['tax'], 12);
  assert.match(s, /^….*the tax is round…$/);
  assert.ok(!s.includes('\n'));
  assert.equal(snippet('short text', ['short']), 'short text');
  assert.equal(snippet('no hit here', ['zzz'], 3), 'no hit…');
});

test('the newest matches come first, up to the limit', () => {
  const items = [1, 2, 3, 4].map((n) => ({ id: `c${n}`, ts: `2026-11-2${n}`, text: n === 3 ? 'nothing' : `deploy ${n}` }));
  const hits = searchItems(items, 'deploy', 2, (x) => x.id, 'chat');
  assert.deepEqual(hits.map((h) => [h.where, h.id, h.snippet]), [['chat', 'c4', 'deploy 4'], ['chat', 'c2', 'deploy 2']]);
  assert.deepEqual(searchItems(items, '', 5, (x) => x.id, 'chat'), []);
});
