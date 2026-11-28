import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QUOTE_MAX, parseReply, readReply, replyExcerpt, withReply } from '../src/shared/reply';

test('a reply carries the quoted message above its own text, and reads back the same', () => {
  const sent = withReply({ who: 'Dispatcher', quote: 'Created 2 tasks. W-02 starts after the first PR is merged.' }, 'Start W-02 now.');
  assert.equal(sent, '[Reply to Dispatcher]\n> Created 2 tasks. W-02 starts after the first PR is merged.\n\nStart W-02 now.');
  assert.deepEqual(parseReply(sent), { who: 'Dispatcher', quote: 'Created 2 tasks. W-02 starts after the first PR is merged.', body: 'Start W-02 now.' });
});

test('without a quote the text is sent as it is', () => {
  assert.equal(withReply(null, 'hello'), 'hello');
  assert.equal(withReply({ who: 'W-03', quote: '  ' }, 'hello'), 'hello');
  assert.equal(parseReply('hello'), null);
  assert.equal(parseReply('> not a reply\n\nhello'), null);
});

test('the quote is one line, without code fences, and cut short', () => {
  assert.equal(replyExcerpt('First line.\n\nSecond line.\n```ts\nconst a = 1;\n```'), 'First line. Second line. const a = 1;');
  const long = replyExcerpt('x'.repeat(QUOTE_MAX + 100));
  assert.equal(long.length, QUOTE_MAX);
  assert.ok(long.endsWith('…'));
});

test('the attached-files block is not quoted', () => {
  assert.equal(replyExcerpt('See the screenshot.\n\n[Attached files]\n- C:\\tmp\\a.png'), 'See the screenshot.');
});

test('replying to a reply quotes only what that message itself said', () => {
  const first = withReply({ who: 'Dispatcher', quote: 'Opened the PR.' }, 'Also update the README.');
  assert.equal(replyExcerpt(first), 'Also update the README.');
});

test('the body keeps its line breaks and its attached files', () => {
  const sent = withReply({ who: 'W-08', quote: 'Replaced two screenshots.' }, 'Light theme too.\nBoth sizes.\n\n[Attached files]\n- C:\\tmp\\a.png');
  assert.equal(parseReply(sent)?.body, 'Light theme too.\nBoth sizes.\n\n[Attached files]\n- C:\\tmp\\a.png');
});

test('a name cannot break out of the heading line', () => {
  const sent = withReply({ who: 'W-0]\n3', quote: 'q' }, 'b');
  assert.deepEqual(parseReply(sent), { who: 'W-0  3', quote: 'q', body: 'b' });
});

test('reply: a reply kept in a draft on disk is read back with its own fields only', () => {
  assert.deepEqual(readReply({ who: 'W-03', quote: 'Done.', task: 'T-1', max: 80, extra: 1 }), { who: 'W-03', quote: 'Done.', task: 'T-1', max: 80 });
  assert.equal(readReply({ who: 'W-03' }), null);
  assert.equal(readReply('W-03'), null);
});
