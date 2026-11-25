import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { firstPage, itemsBefore, pageBefore, pagesFor, slideOlder, threadStart } from '../src/shared/paging';
import { store } from '../src/main/store';
import { paths, ensureHome } from '../src/main/paths';
import { searchMemory, searchMemoryPage } from '../src/main/memory';
import type { ChatItem } from '../src/shared/types';

// The IDE home lives in a temp folder.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-paging-'));
process.env.OMA_DATA_DIR = tmp;
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ home: path.join(tmp, 'home'), language: 'en' }));

const ids = (xs: { id: string }[]) => xs.map((x) => x.id).join(',');
const items = (...xs: string[]) => xs.map((id) => ({ id }));

test('paging: a page before an index, the last page without one', () => {
  assert.deepEqual(pageBefore(1000, undefined, 200), { start: 800, end: 1000 });
  assert.deepEqual(pageBefore(1000, 800, 200), { start: 600, end: 800 });
  assert.deepEqual(pageBefore(1000, 150, 200), { start: 0, end: 150 });
  assert.deepEqual(pageBefore(50, undefined, 200), { start: 0, end: 50 });
  // Past the end counts as the end; nothing before the start.
  assert.deepEqual(pageBefore(10, 99, 4), { start: 6, end: 10 });
  assert.deepEqual(pageBefore(10, 0, 4), { start: 0, end: 0 });
  assert.deepEqual(pageBefore(0, undefined, 4), { start: 0, end: 0 });
});

test('paging: items before an id, and whether more come before them', () => {
  const xs = items('a', 'b', 'c', 'd', 'e');
  assert.deepEqual(itemsBefore(xs, 'e', 2), { items: items('c', 'd'), more: true });
  assert.deepEqual(itemsBefore(xs, 'c', 2), { items: items('a', 'b'), more: false });
  assert.deepEqual(itemsBefore(xs, 'a', 2), { items: [], more: false });
  // An id the cap dropped has nothing kept before it.
  assert.deepEqual(itemsBefore(xs, 'gone', 2), { items: [], more: false });
});

test('paging: items that slide out of the snapshot join the older ones', () => {
  const prev = items('c', 'd', 'e'), next = items('e', 'f', 'g');
  assert.equal(ids(slideOlder(items('a', 'b'), prev, next)), 'a,b,c,d');
  // Nothing older held: kept only while the thread shows them.
  assert.equal(ids(slideOlder([], prev, next)), '');
  assert.equal(ids(slideOlder([], prev, next, 'd')), 'c,d');
  assert.equal(ids(slideOlder([], prev, next, 'f')), '');
  // The snapshot didn't move.
  const older = items('a');
  assert.equal(slideOlder(older, prev, items('c', 'd', 'e', 'f')), older);
  // A burst longer than a snapshot leaves a gap: the older items are dropped.
  assert.equal(ids(slideOlder(items('a', 'b'), prev, items('x', 'y'))), '');
  assert.equal(ids(slideOlder(items('a'), prev, [])), '');
});

test('paging: a thread keeps its start while items arrive, and goes back to a page when following', () => {
  // First render: the last page.
  assert.equal(threadStart(1000, -1, 100, true), 900);
  assert.equal(threadStart(40, -1, 100, false), 0);
  // New items below a reader who scrolled up: the start stays.
  assert.equal(threadStart(1300, 900, 100, false), 900);
  // Following the end: grown up to two pages it stays, past that back to the last page.
  assert.equal(threadStart(1100, 900, 100, true), 900);
  assert.equal(threadStart(1101, 900, 100, true), 1001);
  // A start that is gone (more than held) is a first render.
  assert.equal(threadStart(10, 50, 100, false), 0);
});

test('paging: "Show more" lists show whole pages, enough to reach an item', () => {
  const xs = Array.from({ length: 75 }, (_, i) => i);
  assert.deepEqual(firstPage(xs, 30).items.length, 30);
  assert.equal(firstPage(xs, 30).left, 45);
  assert.equal(firstPage(xs, 90).left, 0);
  assert.equal(firstPage(xs, 90).items.length, 75);
  assert.equal(pagesFor(10, 30, 30), 30);
  assert.equal(pagesFor(30, 30, 30), 60);
  assert.equal(pagesFor(74, 30, 30), 90);
});

test('store: a 1000-line Worker log reads a page at a time, and a torn line is skipped', async () => {
  ensureHome();
  const file = path.join(paths().workerLogs, 'W-99.jsonl');
  const lines = Array.from({ length: 1000 }, (_, i) => JSON.stringify({ ts: new Date(i * 1000).toISOString(), from: 'event', text: `line ${i}` }));
  lines[500] = '{"ts": "torn';
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const last = await store.readLog('W-99');
  assert.equal(last.start, 800);
  assert.equal(last.total, 1000);
  assert.equal(last.items.length, 200);
  assert.equal(last.items[0].text, 'line 800');
  assert.equal(last.items[199].text, 'line 999');
  const before = await store.readLog('W-99', last.start, 300);
  assert.equal(before.start, 500);
  assert.equal(before.items.length, 299);
  assert.equal(before.items[0].text, 'line 501');
  const first = await store.readLog('W-99', 100);
  assert.deepEqual([first.start, first.items.length, first.items[0].text], [0, 100, 'line 0']);
  // A line written after the read continues where the page ended.
  store.log('W-99', 'event', 'line 1000');
  assert.deepEqual((await store.readLog('W-99', undefined, 1)).items.map((x) => x.text), ['line 1000']);
  assert.deepEqual(await store.readLog('W-00'), { items: [], start: 0, total: 0 });
});

test('store: chat pages go back from an id', () => {
  store.data.chat = Array.from({ length: 450 }, (_, i): ChatItem => ({ id: `c${i}`, ts: new Date(i).toISOString(), kind: 'event', text: String(i) }));
  const p = store.chatPage('c50');
  assert.deepEqual([p.items.length, p.items[0].id, p.items[49].id, p.more], [50, 'c0', 'c49', false]);
  const q = store.chatPage('c400', 100);
  assert.deepEqual([q.items[0].id, q.items[99].id, q.more], ['c300', 'c399', true]);
});

test('memory: search hits page with an offset, best first', () => {
  ensureHome();
  const notes = Array.from({ length: 70 }, (_, i) => `- paging note ${i}${i % 10 === 0 ? ' extra' : ''}`);
  fs.writeFileSync(path.join(paths().memory, 'notes.md'), `# Notes\n${notes.join('\n')}\n`);
  const a = searchMemoryPage('paging extra', 0, 30), b = searchMemoryPage('paging extra', 30, 30), c = searchMemoryPage('paging extra', 60, 30);
  assert.deepEqual([a.total, a.hits.length, b.hits.length, c.hits.length], [70, 30, 30, 10]);
  const all = [...a.hits, ...b.hits, ...c.hits].map((h) => h.line);
  assert.equal(new Set(all).size, 70);
  // The seven lines with both words come first.
  assert.ok(a.hits.slice(0, 7).every((h) => h.text.endsWith('extra')));
  assert.ok(!a.hits[7].text.endsWith('extra'));
  assert.deepEqual(searchMemory('paging extra', 30).map((h) => h.line), a.hits.map((h) => h.line));
  assert.deepEqual(searchMemoryPage('', 0, 30), { hits: [], total: 0 });
});
