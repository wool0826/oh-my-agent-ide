import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tr } from '../src/shared/i18n';
import type { Say } from '../src/shared/askWhy';
import { artifactCommentLine, parseArtifactComment, userMessageText, writesComment } from '../src/shared/artifactComment';

const en: Say = (k, v) => tr('en', k, v);
const URL = 'https://claude.ai/artifact/2hL4515n1HmJCSDrwV96T7';

test('a comment turn is told apart by its heading, with the comment and the artifact', () => {
  const text = `[Artifact comment sent to Claude] ${URL};thread=th_1\nComment: Please check the numbers in row 2 of the table`;
  assert.deepEqual(parseArtifactComment(text), { excerpt: 'Please check the numbers in row 2 of the table', url: URL });
  // Without a label: the first line that is not a link or a label.
  assert.deepEqual(parseArtifactComment(`[Artifact comment sent to Claude]\nartifact: ${URL}\n"Fix the title"`), { excerpt: 'Fix the title', url: URL });
  assert.equal(parseArtifactComment('Please check the numbers'), null);
  assert.equal(parseArtifactComment(`Look at ${URL}`), null);
});

test('only the text blocks of a user message are read', () => {
  assert.equal(userMessageText('hi'), 'hi');
  assert.equal(userMessageText([{ type: 'tool_result', content: 'x' }, { type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb');
  assert.equal(userMessageText(null), '');
});

test('only a reply with words counts as answering the comment', () => {
  assert.equal(writesComment('ArtifactComments', { action: 'reply', url: URL, thread_id: 't', text: 'Fixed.' }), true);
  assert.equal(writesComment('ArtifactComments', { action: 'reply', url: URL, thread_id: 't', text: ' ' }), false);
  assert.equal(writesComment('ArtifactComments', { action: 'read', url: URL }), false);
  assert.equal(writesComment('ArtifactComments', { action: 'resolve', url: URL, thread_id: 't' }), false);
  assert.equal(writesComment('Artifact', { action: 'reply', text: 'x' }), false);
});

test('the event lines say what came in and whether it was answered', () => {
  const comment = { excerpt: 'Fix the title', url: URL };
  assert.equal(artifactCommentLine(en, { phase: 'start', comment, replied: false }), `claude.ai artifact comment · "Fix the title" · ${URL}`);
  assert.equal(artifactCommentLine(en, { phase: 'start', comment: { excerpt: '', url: null }, replied: false }), 'claude.ai artifact comment');
  assert.equal(artifactCommentLine(en, { phase: 'end', comment, replied: true }), 'Replied to the artifact comment.');
  assert.equal(artifactCommentLine(en, { phase: 'end', comment, replied: false }), 'Did not reply to the artifact comment.');
});
