import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPreset, cleanPreset, cleanPrompt, filterCommands, filterPrompts, insertPrompt, presetNote, presetOf, promptCmd, slashAt } from '../src/shared/prompts';
import type { SavedPrompt } from '../src/shared/types';

const saved = (cmd: string, name: string): SavedPrompt => ({ id: cmd, cmd, name, text: `${name} text`, repo: '', model: '', planFirst: false, createdAt: '', updatedAt: '' });
const list = [saved('release', '릴리스'), saved('deps', '의존성 올리기'), saved('review', 'PR 리뷰'), saved('mock', 'UI 시안')];

test('prompts: a command is stored without its slash, in lower case, with spaces as dashes', () => {
  assert.equal(promptCmd(' /Release Notes! '), 'release-notes');
  assert.equal(promptCmd('//리뷰'), '리뷰');
});

test('prompts: cleanPrompt keeps the fields and says what is missing or taken', () => {
  const ok = cleanPrompt({ name: ' 릴리스 ', cmd: '/release', text: '\r\nWrite the notes\r\n', repo: 'app', model: 'claude-opus-5-5', planFirst: true });
  assert.deepEqual(ok, { ok: true, value: { name: '릴리스', cmd: 'release', text: 'Write the notes', repo: 'app', model: 'claude-opus-5-5', planFirst: true } });
  assert.deepEqual(cleanPrompt({ name: '', cmd: 'a', text: 'b' }), { ok: false, error: 'prompt.err.name' });
  assert.deepEqual(cleanPrompt({ name: 'a', cmd: '/', text: 'b' }), { ok: false, error: 'prompt.err.cmd' });
  assert.deepEqual(cleanPrompt({ name: 'a', cmd: 'a', text: '  ' }), { ok: false, error: 'prompt.err.text' });
  assert.deepEqual(cleanPrompt({ name: 'a', cmd: 'compact', text: 'b' }), { ok: false, error: 'prompt.err.taken' });
  assert.deepEqual(cleanPrompt({ name: 'a', cmd: 'deps', text: 'b' }, list), { ok: false, error: 'prompt.err.taken' });
  assert.equal(cleanPrompt({ name: 'a', cmd: 'deps', text: 'b', planFirst: 'yes' }).ok, true);
});

test('prompts: slashAt finds a slash only at the start of a line and before any space', () => {
  assert.deepEqual(slashAt('/', 1), { start: 0, query: '' });
  assert.deepEqual(slashAt('/re', 3), { start: 0, query: 're' });
  assert.deepEqual(slashAt('first line\n/de', 14), { start: 11, query: 'de' });
  assert.equal(slashAt('a /re', 5), null);
  assert.equal(slashAt('/re view', 8), null);
  assert.equal(slashAt('/re', 0), null);
  assert.equal(slashAt('/usr/bin', 8), null);
});

test('prompts: filterPrompts puts commands that start with the query first, then names that hold it', () => {
  assert.deepEqual(filterPrompts(list, '').map((p) => p.cmd), ['release', 'deps', 'review', 'mock']);
  assert.deepEqual(filterPrompts(list, 're').map((p) => p.cmd), ['release', 'review']);
  assert.deepEqual(filterPrompts(list, 'ui').map((p) => p.cmd), ['mock']);
  assert.deepEqual(filterPrompts(list, 'xyz'), []);
  assert.deepEqual(filterCommands(''), ['compact', 'new']);
  assert.deepEqual(filterCommands('n'), ['new']);
});

test('prompts: insertPrompt puts the text in place of the slash and its query', () => {
  assert.deepEqual(insertPrompt('/re', { start: 0, query: 're' }, 'Release it'), { value: 'Release it', caret: 10 });
  assert.deepEqual(insertPrompt('a\n/re\nb', { start: 2, query: 're' }, 'X'), { value: 'a\nX\nb', caret: 3 });
});

test('prompts: a preset with nothing set is none, and one from the window keeps only a registered repository', () => {
  assert.equal(presetOf({ repo: '', model: '', planFirst: false }), null);
  assert.deepEqual(presetOf({ repo: '', model: 'm', planFirst: false }), { repo: '', model: 'm', planFirst: false });
  const has = (n: string) => n === 'app';
  assert.deepEqual(cleanPreset({ repo: 'app', model: 'm', planFirst: true, x: 1 }, has), { repo: 'app', model: 'm', planFirst: true });
  assert.equal(cleanPreset({ repo: 'gone' }, has), null);
  assert.equal(cleanPreset('x', has), null);
});

test('prompts: applyPreset sets the model and plan first, and the repository only when none is given', () => {
  const p = { repo: 'app', model: 'claude-sonnet-5-5', planFirst: true };
  const args: { title: string; repo?: string } = { title: 't' };
  assert.deepEqual(applyPreset(args, p), { title: 't', repo: 'app', model_id: 'claude-sonnet-5-5', plan_first: true });
  assert.deepEqual(applyPreset({ repo: 'web' }, { repo: 'app', model: '', planFirst: false }), { repo: 'web' });
  assert.deepEqual(applyPreset({ repo: 'web' }, null), { repo: 'web' });
  assert.match(presetNote(p, 'Sonnet 5.5'), /repository app; model Sonnet 5\.5; plan first/);
});
