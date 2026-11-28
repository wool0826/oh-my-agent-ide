import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DISPATCHER_DRAFT, Drafts, parseDraft } from '../src/shared/drafts';
import { menuPlace } from '../src/shared/menu';

const none = { text: '', files: [], reply: null };

test('a draft waits for its own Worker', () => {
  const d = new Drafts<string>();
  d.put('W-01', { text: 'for one', files: ['a.png'], reply: 'quote' });
  assert.deepEqual(d.take('W-02'), none);
  assert.deepEqual(d.take('W-01'), { text: 'for one', files: ['a.png'], reply: 'quote' });
  // Handed to the composer: not kept twice.
  assert.deepEqual(d.take('W-01'), none);
});

test('an empty composer leaves no draft', () => {
  const d = new Drafts<string>();
  d.put('W-01', { text: 'x', files: [], reply: null });
  d.put('W-01', { text: '  \n', files: [], reply: null });
  assert.equal(d.has('W-01'), false);
  d.put('W-01', { text: '', files: ['a.png'], reply: null });
  assert.equal(d.has('W-01'), true);
});

test('the kept files are a copy', () => {
  const d = new Drafts<string>();
  const files = ['a.png'];
  d.put('W-01', { text: '', files, reply: null });
  files.push('b.png');
  assert.deepEqual(d.take('W-01').files, ['a.png']);
});

test('a message that went while another Worker was open leaves its draft', () => {
  const d = new Drafts<string>();
  d.put('W-01', { text: 'sent text', files: ['a.png', 'b.png'], reply: 'quote' });
  d.sent('W-01', 'sent text', ['a.png'], 'quote');
  // A file added after the send stays.
  assert.deepEqual(d.take('W-01'), { text: '', files: ['b.png'], reply: null });
  d.put('W-01', { text: 'sent text', files: [], reply: null });
  d.sent('W-01', 'sent text', [], null);
  assert.equal(d.has('W-01'), false);
  // Text changed after the send is a new draft.
  d.put('W-01', { text: 'sent text and more', files: [], reply: null });
  d.sent('W-01', 'sent text', [], null);
  assert.equal(d.take('W-01').text, 'sent text and more');
});

test('drafts of Workers that are gone are dropped', () => {
  const d = new Drafts<string>();
  d.put('W-01', { text: 'a', files: [], reply: null });
  d.put('W-02', { text: 'b', files: [], reply: null });
  d.keep((id) => id === 'W-02');
  assert.equal(d.has('W-01'), false);
  assert.equal(d.has('W-02'), true);
});

test('a context menu opens at the pointer and stays inside the window', () => {
  assert.deepEqual(menuPlace(100, 100, 180, 70, 1000, 700), { left: 100, top: 100 });
  assert.deepEqual(menuPlace(950, 690, 180, 70, 1000, 700), { left: 812, top: 622 });
  // Bigger than the window: the top left wins.
  assert.deepEqual(menuPlace(50, 50, 400, 300, 300, 200), { left: 8, top: 8 });
});

test('drafts: what is kept for the next start has the composers on screen too, without the empty ones', () => {
  const d = new Drafts<string>();
  d.put('W-01', { text: 'for one', files: [], reply: null });
  d.put('W-02', { text: 'for two', files: [], reply: null });
  const saved = d.saved({ 'W-02': none, [DISPATCHER_DRAFT]: { text: 'to the Dispatcher', files: ['a.png'], reply: null } });
  assert.deepEqual(saved, { 'W-01': { text: 'for one', files: [], reply: null }, [DISPATCHER_DRAFT]: { text: 'to the Dispatcher', files: ['a.png'], reply: null } });
  // Saving takes nothing away from the drafts held.
  assert.equal(d.has('W-02'), true);
});

test('drafts: the next start gets back the drafts of the Workers still there', () => {
  const d = new Drafts<string>();
  d.load({ 'W-01': { text: 'one', files: ['a', 3], reply: 'q' }, 'W-09': { text: 'gone', files: [] }, 'W-02': { files: [] } }, (id) => id !== 'W-09', (r) => (typeof r === 'string' ? r : null));
  assert.deepEqual(d.take('W-01'), { text: 'one', files: ['a'], reply: 'q' });
  assert.equal(d.has('W-09'), false);
  assert.equal(d.has('W-02'), false);
  assert.equal(parseDraft('text', () => null), null);
});
