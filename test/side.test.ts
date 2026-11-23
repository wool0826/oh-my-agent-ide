// A side question (shared/side.ts): what crosses over to the Dispatcher, and what the thread keeps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addSideItem, lastAnswer, sideModel, sideReply, SIDE_QUOTE_MAX, SIDE_WHO, type SideItem } from '../src/shared/side';
import { parseReply, QUOTE_MAX, withReply } from '../src/shared/reply';
import { inFolder } from '../src/main/side';
import path from 'node:path';

test('an answer sent to the Dispatcher goes as a quote from the side question, above what the user writes', () => {
  const text = withReply(sideReply('rebase --onto moves a range of commits.\n\nCherry-pick copies them.'), 'Use this for W-03.');
  assert.equal(text, `[Reply to ${SIDE_WHO}]\n> rebase --onto moves a range of commits. Cherry-pick copies them.\n\nUse this for W-03.`);
  const back = parseReply(text);
  assert.equal(back?.who, SIDE_WHO);
  assert.equal(back?.body, 'Use this for W-03.');
});

test('a side answer keeps more than a reply quote, and is cut with an ellipsis past its own cap', () => {
  const long = 'word '.repeat(1000);
  const quote = parseReply(withReply(sideReply(long), 'x'))!.quote;
  assert.ok(quote.length > QUOTE_MAX);
  assert.equal(quote.length, SIDE_QUOTE_MAX);
  assert.ok(quote.endsWith('…'));
  // A plain reply is still cut at its own size.
  assert.ok(parseReply(withReply({ who: 'W-03', quote: long }, 'x'))!.quote.length <= QUOTE_MAX);
});

test('the answer taken is everything said since the last question', () => {
  const items: SideItem[] = [
    { role: 'me', text: 'first?' }, { role: 'ai', text: 'one' },
    { role: 'me', text: 'second?' }, { role: 'ai', text: 'Looking at the docs.' }, { role: 'ai', text: 'two' },
  ];
  assert.equal(lastAnswer(items), 'Looking at the docs.\n\ntwo');
  assert.equal(lastAnswer([...items, { role: 'me', text: 'third?' }]), null);
  assert.equal(lastAnswer([{ role: 'me', text: 'q' }, { role: 'error', text: 'failed' }]), null);
  assert.equal(lastAnswer([]), null);
});

test('the thread keeps its newest items', () => {
  let items: SideItem[] = [];
  for (let i = 0; i < 5; i++) items = addSideItem(items, { role: 'me', text: String(i) }, 3);
  assert.deepEqual(items.map((x) => x.text), ['2', '3', '4']);
});

test('it starts on the newest Sonnet the accounts have, else the newest Claude model', () => {
  const m = (id: string, created: string, provider?: 'claude' | 'chatgpt') => ({ id, name: id, created, provider });
  assert.equal(sideModel([m('claude-opus-5-5', '2026-09'), m('claude-sonnet-5-0', '2026-03'), m('claude-sonnet-5-5', '2026-08')]), 'claude-sonnet-5-5');
  assert.equal(sideModel([m('claude-opus-5-5', '2026-09'), m('gpt-6', '2026-10', 'chatgpt')]), 'claude-opus-5-5');
  assert.equal(sideModel([]), 'claude-sonnet-5-5');
});

test('its file tools read only under its own folder; the web tools are not about files', () => {
  const cwd = path.resolve('/work/shop');
  assert.equal(inFolder(cwd, 'Read', { file_path: path.join(cwd, 'src', 'a.ts') }), true);
  assert.equal(inFolder(cwd, 'Read', { file_path: 'src/a.ts' }), true);
  assert.equal(inFolder(cwd, 'Read', { file_path: path.resolve('/home/me/.ssh/id_rsa') }), false);
  assert.equal(inFolder(cwd, 'Grep', { pattern: 'x', path: '../other' }), false);
  assert.equal(inFolder(cwd, 'Glob', { pattern: '**/*.ts' }), true);
  assert.equal(inFolder(cwd, 'WebFetch', { url: 'https://example.com' }), true);
});
