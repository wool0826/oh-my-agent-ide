import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alreadyKnown, answerWorthChecking, canSuggest, memTerms, overlap, pickSuggestion, sourceTag, trimSuggestions } from '../src/shared/memorySuggest';
import { ALLOW, DENY, type MemorySuggestion } from '../src/shared/types';

const card = (key: string, status: MemorySuggestion['status'] = 'pending', id = key): MemorySuggestion => ({
  id, key, taskId: key, workerId: 'W-01', repo: null, scope: 'preference', text: 'x', reason: '', source: key, status, createdAt: '2026-11-21T00:00:00Z',
});

test('suggest: a bare allow or deny is not worth a check', () => {
  assert.equal(answerWorthChecking(ALLOW), false);
  assert.equal(answerWorthChecking(DENY), false);
  assert.equal(answerWorthChecking('  '), false);
  assert.equal(answerWorthChecking(null), false);
  assert.equal(answerWorthChecking('Use pnpm'), true);
  assert.equal(answerWorthChecking('Never push to main directly'), true);
});

test('suggest: at most one card per task, dismissed or saved ones count too', () => {
  assert.equal(canSuggest([], 'T-0001'), true);
  assert.equal(canSuggest([card('T-0001')], 'T-0001'), false);
  assert.equal(canSuggest([card('T-0001', 'dismissed')], 'T-0001'), false);
  assert.equal(canSuggest([card('T-0001', 'saved')], 'T-0001'), false);
  assert.equal(canSuggest([card('T-0001')], 'T-0002'), true);
  // A check already running for the task blocks a second one.
  assert.equal(canSuggest([], 'T-0003', new Set(['T-0003'])), false);
});

test('suggest: the source names the task, the Worker and the short decision id', () => {
  assert.equal(sourceTag({ taskId: 'T-0014', workerId: 'W-13', kind: 'decision', id: '1a2b3c4d-5e6f-7a8b' }), 'T-0014 W-13 decision:1a2b3c4d');
  assert.equal(sourceTag({ taskId: null, workerId: null, kind: 'decision', id: 'abcdef1234' }), 'decision:abcdef12');
  assert.equal(sourceTag({ taskId: null, workerId: 'W-02', kind: 'correction', id: 'ffff0000aa' }), 'W-02 correction:ffff0000');
});

test('suggest: only a sure, new, well-formed answer becomes a card', () => {
  const ok = { remember: true, duplicate: false, confidence: 'high', scope: 'preference', text: '  Use   pnpm, not npm. ', reason: 'Saves asking.' };
  assert.deepEqual(pickSuggestion(ok, null), { scope: 'preference', text: 'Use pnpm, not npm.', reason: 'Saves asking.' });
  assert.equal(pickSuggestion({ ...ok, confidence: 'medium' }, null), null);
  assert.equal(pickSuggestion({ ...ok, confidence: 'low' }, null), null);
  assert.equal(pickSuggestion({ ...ok, remember: false }, null), null);
  assert.equal(pickSuggestion({ ...ok, duplicate: true }, null), null);
  assert.equal(pickSuggestion({ ...ok, text: 'ok' }, null), null);
  assert.equal(pickSuggestion({ ...ok, text: 'x'.repeat(301) }, null), null);
  assert.equal(pickSuggestion({ ...ok, scope: 'task' }, null), null);
  assert.equal(pickSuggestion(null, null), null);
  assert.equal(pickSuggestion('{"remember":true}', null), null);
});

test('suggest: a repository trait needs a repository', () => {
  const out = { remember: true, duplicate: false, confidence: 'high', scope: 'repo', text: 'Tests run with npm test.', reason: '' };
  assert.equal(pickSuggestion(out, null), null);
  assert.equal(pickSuggestion(out, 'web')?.scope, 'repo');
});

test('suggest: words match across Korean particles', () => {
  assert.deepEqual(memTerms('pnpm을 써요'), ['pnpm', '써요']);
  assert.equal(overlap('PR 본문은 한국어로', '- PR 본문 한국어 _(2026-11-20)_'), 1);
  assert.equal(overlap('', 'anything'), 0);
});

test('suggest: memory already holds a fact when one line has most of its words', () => {
  const lines = ['- Use pnpm, not npm, in this repository. _(2026-11-01)_', '- PR titles in Korean'];
  assert.equal(alreadyKnown('Use pnpm instead of npm in this repository', lines), true);
  assert.equal(alreadyKnown('Run the linter before every commit', lines), false);
  assert.equal(alreadyKnown('Anything', []), false);
});

test('suggest: trimming drops the oldest answered cards and keeps waiting ones', () => {
  const list = [card('a', 'saved'), card('b', 'pending'), card('c', 'dismissed'), card('d', 'saved'), card('e', 'pending')];
  assert.deepEqual(trimSuggestions(list, 5).map((s) => s.key), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(trimSuggestions(list, 3).map((s) => s.key), ['b', 'd', 'e']);
  assert.deepEqual(trimSuggestions(list, 1).map((s) => s.key), ['b', 'e']);
});
