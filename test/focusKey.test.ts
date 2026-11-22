import { test } from 'node:test';
import assert from 'node:assert/strict';
import { focusSelector, hasName } from '../src/shared/focusKey';

test('a control is found again by its tag, its action and what it acts on', () => {
  assert.equal(focusSelector('BUTTON', { action: 'answer', id: 'd1', val: 'allow' }), 'button[data-action="answer"][data-id="d1"]');
  assert.equal(focusSelector('DIV', { action: 'open-worker', id: 'W-01' }), 'div[data-action="open-worker"][data-id="W-01"]');
  assert.equal(focusSelector('A', { action: 'open-url', href: 'https://github.com/o/r/pull/1' }), 'a[data-action="open-url"][data-href="https://github.com/o/r/pull/1"]');
  assert.equal(focusSelector('BUTTON', { action: 'ins-tab', v: 'memo' }), 'button[data-action="ins-tab"][data-v="memo"]');
});

test('values are quoted so they cannot break the selector', () => {
  assert.equal(focusSelector('BUTTON', { action: 'grant-revoke', id: 'T-1', key: 'Edit:c:\\work\\"x"' }), 'button[data-action="grant-revoke"][data-id="T-1"][data-key="Edit:c:\\\\work\\\\\\"x\\""]');
});

test('an element that is not one of the app\'s controls is left alone', () => {
  assert.equal(focusSelector('INPUT', { keep: 'dec-1' }), null);
});

test('a control is named by a label, a title, its text, a label element or a placeholder', () => {
  const none = { ariaLabel: null, title: '', text: '  ', labelled: false };
  assert.equal(hasName(none), false);
  assert.equal(hasName({ ...none, ariaLabel: 'Send' }), true);
  assert.equal(hasName({ ...none, title: 'Refresh' }), true);
  assert.equal(hasName({ ...none, text: 'Allow' }), true);
  assert.equal(hasName({ ...none, labelled: true }), true);
  assert.equal(hasName({ ...none, placeholder: 'Search' }), true);
});
