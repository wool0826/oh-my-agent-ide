import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pageBefore, scanLines } from '../src/shared/paging';
import { searchItems, SEARCH_MIN, type TextHit } from '../src/shared/textSearch';
import { store } from '../src/main/store';
import { ensureHome, paths } from '../src/main/paths';
import { forgetLogIndexes } from '../src/main/logFile';
import type { LogPage, Worker, WorkerLogItem } from '../src/shared/types';

// The IDE home lives in a temp folder.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-logfile-'));
process.env.OMA_DATA_DIR = tmp;
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ home: path.join(tmp, 'home'), language: 'en' }));
ensureHome();

const logPath = (id: string) => path.join(paths().workerLogs, `${id}.jsonl`);

// How the store read logs before (whole and synchronously): what the new reads must give back.
function oldReadLog(id: string, before: number | undefined, limit: number): LogPage {
  let lines: string[];
  try { lines = fs.readFileSync(logPath(id), 'utf8').split('\n').filter(Boolean); } catch { return { items: [], start: 0, total: 0 }; }
  const { start, end } = pageBefore(lines.length, before, limit);
  const items: WorkerLogItem[] = [];
  for (const l of lines.slice(start, end)) { try { items.push(JSON.parse(l) as WorkerLogItem); } catch { /* torn */ } }
  return { items, start, total: lines.length };
}
function oldSearchText(query: string, limit = 24): TextHit[] {
  if (query.trim().length < SEARCH_MIN) return [];
  const said = store.data.chat.filter((c) => c.kind === 'user' || c.kind === 'dispatcher');
  const out = searchItems(said, query, Math.ceil(limit / 2), (c) => c.id, 'chat');
  const workers = [...store.data.workers].sort((a, b) => Number(a.status === 'archived') - Number(b.status === 'archived') || b.lastActiveAt.localeCompare(a.lastActiveAt));
  for (const w of workers) {
    if (out.length >= limit) break;
    let items: WorkerLogItem[];
    try {
      items = fs.readFileSync(logPath(w.id), 'utf8').split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l) as WorkerLogItem; } catch { return { ts: '', from: 'event' as const, text: '' }; } });
    } catch { continue; }
    const lines = items.map((x) => (x.from === 'event' ? { ...x, text: '' } : x));
    out.push(...searchItems(lines, query, Math.min(4, limit - out.length), (_x, i) => String(i), w.id));
  }
  return out.slice(0, limit);
}

/** A large log: Korean and English, events, long lines, torn lines, blank lines, and a last line without its "\n". */
function bigLog(n: number, seed: number): string {
  const froms: WorkerLogItem['from'][] = ['dispatcher', 'worker', 'event', 'user'];
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const from = froms[(i * 7 + seed) % froms.length];
    const text = i % 97 === 0 ? `파서 수정 ${i} ${'가'.repeat(3000)}` : i % 13 === 0 ? `parser fix ${i} needle-${seed}` : `line ${i} 작업 진행 중`;
    let line = JSON.stringify({ ts: new Date(Date.UTC(2026, 10, 1) + i * 1000).toISOString(), from, text });
    if (i % 1009 === 0) line = line.slice(0, 20); // torn
    parts.push(line + (i % 499 === 0 ? '\n\n' : '\n'));
  }
  return parts.join('') + JSON.stringify({ ts: '2026-11-30T00:00:00.000Z', from: 'worker', text: 'last needle-' + seed });
}

test('scanLines: line starts are the same however the bytes are cut into chunks', () => {
  const buf = Buffer.from('\n\nab\nc\n\n가나\n\nd', 'utf8');
  const whole: number[] = [];
  assert.equal(scanLines(buf, 0, whole, false), true);
  const lines = buf.toString('utf8').split('\n').filter(Boolean);
  assert.equal(whole.length, lines.length);
  assert.deepEqual(whole.map((s, i) => buf.subarray(s, whole[i + 1] ?? buf.length).toString('utf8').split('\n')[0]), lines);
  for (let cut = 0; cut <= buf.length; cut++) {
    for (let cut2 = cut; cut2 <= buf.length; cut2++) {
      const starts: number[] = [];
      let inLine = scanLines(buf.subarray(0, cut), 0, starts, false);
      inLine = scanLines(buf.subarray(cut, cut2), cut, starts, inLine);
      inLine = scanLines(buf.subarray(cut2), cut2, starts, inLine);
      assert.deepEqual(starts, whole, `cut at ${cut}, ${cut2}`);
      assert.equal(inLine, true);
    }
  }
  const ended: number[] = [];
  assert.equal(scanLines(Buffer.from('a\n'), 0, ended, false), false);
  assert.equal(scanLines(Buffer.from(''), 0, ended, true), true, 'nothing new: still inside the line');
});

test('paging a large log gives the same pages as reading it whole, and follows what is appended', async () => {
  const text = bigLog(40_000, 1);
  fs.writeFileSync(logPath('W-90'), text);
  assert.ok(text.length > 2 * (1 << 20), 'more than one chunk');
  const want = oldReadLog('W-90', undefined, 200);
  assert.deepEqual(await store.readLog('W-90'), want);
  // Walk back to the start page by page, as the window does.
  let before: number | undefined = want.start;
  let pages = 0;
  while (before) {
    assert.deepEqual(await store.readLog('W-90', before, 1000), oldReadLog('W-90', before, 1000), `page before ${before}`);
    before = Math.max(0, before - 1000);
    pages++;
  }
  assert.ok(pages > 30);
  for (const [b, l] of [[0, 10], [1, 1], [99_999, 5], [12_345, 0], [undefined, 1000]] as const) {
    assert.deepEqual(await store.readLog('W-90', b, l), oldReadLog('W-90', b, l), `before ${b}, limit ${l}`);
  }
  // The last line had no "\n" yet; its end and the lines after it arrive.
  fs.appendFileSync(logPath('W-90'), '\n');
  store.log('W-90', 'worker', 'appended 1');
  store.log('W-90', 'event', 'appended 2');
  for (const b of [undefined, 39_990]) assert.deepEqual(await store.readLog('W-90', b, 50), oldReadLog('W-90', b, 50));
  // A log written anew (shorter) is read anew.
  fs.writeFileSync(logPath('W-90'), bigLog(30, 2));
  assert.deepEqual(await store.readLog('W-90'), oldReadLog('W-90', undefined, 200));
  // Reads at the same time agree.
  const many = await Promise.all([store.readLog('W-90', undefined, 5), store.readLog('W-90', 10, 5)]);
  assert.deepEqual(many, [oldReadLog('W-90', undefined, 5), oldReadLog('W-90', 10, 5)]);
  assert.deepEqual(await store.readLog('W-missing'), { items: [], start: 0, total: 0 });
});

test('searching large logs gives the same hits as reading them whole', async () => {
  forgetLogIndexes();
  const w = (id: string, status: Worker['status'], lastActiveAt: string) => ({ id, status, lastActiveAt }) as Worker;
  store.data.workers = [w('W-91', 'idle', '2026-11-02'), w('W-92', 'archived', '2026-11-03'), w('W-93', 'idle', '2026-11-04'), w('W-94', 'idle', '2026-11-01')];
  fs.writeFileSync(logPath('W-91'), bigLog(30_000, 1));
  fs.writeFileSync(logPath('W-92'), bigLog(5_000, 2));
  fs.writeFileSync(logPath('W-93'), bigLog(12_000, 3));
  store.data.chat = [
    { id: 'c1', ts: '2026-11-01T00:00:00.000Z', kind: 'user', text: 'parser fix please' },
    { id: 'c2', ts: '2026-11-01T00:00:01.000Z', kind: 'event', text: 'parser fix event' },
  ];
  for (const q of ['parser fix', 'needle-1', 'needle-3', '파서 수정', '작업', 'line 5', 'nothing like this', 'x']) {
    for (const limit of [24, 3]) {
      assert.deepEqual(await store.searchText(q, limit), oldSearchText(q, limit), `${q} (${limit})`);
    }
  }
  // Rare matches deep in a log are still found: a line near the start.
  fs.writeFileSync(logPath('W-94'), JSON.stringify({ ts: 't', from: 'worker', text: 'only-once' }) + '\n' + bigLog(10_000, 4));
  assert.deepEqual(await store.searchText('only-once'), oldSearchText('only-once'));
  assert.equal((await store.searchText('only-once')).length, 1);
});
