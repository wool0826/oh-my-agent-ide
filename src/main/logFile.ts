// Reading Worker logs (jsonl, appended to as Workers talk) without reading them whole. Each log gets an index of
// where its lines start, built once per launch with a byte scan and extended by the bytes appended since; a page
// or a search then reads only the lines it needs, from the end. All of it is async, so the main process stays
// free for the window while a large log is read. Logs are only appended to (store.log); one rewritten in place to
// the same size or longer would not be noticed, while one that shrank or was deleted and written anew is.

import fs from 'node:fs/promises';
import { pageBefore, scanLines } from '../shared/paging';
import { searchItems, type TextHit } from '../shared/textSearch';
import type { LogPage, WorkerLogItem } from '../shared/types';

/** Bytes read at a time while indexing. */
const CHUNK = 1 << 20;
/** Lines read at a time while searching from the end. */
const SEARCH_BATCH = 2000;

interface LineIndex {
  /** The file it was built from: a log deleted and written again starts over. */
  id: string;
  /** Bytes scanned so far. */
  size: number;
  starts: number[];
  /** The last scanned byte is inside a line (one still being written, or the last without its "\n"). */
  inLine: boolean;
}

const indexes = new Map<string, LineIndex>();
/** One update at a time per file, so two reads don't scan the same bytes twice. */
const updating = new Map<string, Promise<LineIndex | null>>();

/** The index of a log as it is now on disk; null when there is no such file. */
function lineIndex(file: string): Promise<LineIndex | null> {
  const prev = updating.get(file) ?? Promise.resolve(null);
  const next = prev.catch(() => null).then(() => update(file));
  updating.set(file, next);
  void next.finally(() => { if (updating.get(file) === next) updating.delete(file); }).catch(() => {});
  return next;
}

async function update(file: string): Promise<LineIndex | null> {
  let fh: fs.FileHandle;
  try { fh = await fs.open(file, 'r'); } catch { indexes.delete(file); return null; }
  try {
    const st = await fh.stat();
    const id = `${st.ino}:${st.birthtimeMs}`;
    let ix = indexes.get(file);
    if (!ix || ix.id !== id || st.size < ix.size) ix = { id, size: 0, starts: [], inLine: false };
    const buf = Buffer.allocUnsafe(CHUNK);
    while (ix.size < st.size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, st.size - ix.size), ix.size);
      if (!bytesRead) break;
      ix.inLine = scanLines(buf.subarray(0, bytesRead), ix.size, ix.starts, ix.inLine);
      ix.size += bytesRead;
    }
    indexes.set(file, ix);
    return ix;
  } finally {
    await fh.close().catch(() => {});
  }
}

/** Lines [start, end) of an indexed log, parsed; a line that does not parse is null. */
async function readLines(file: string, ix: LineIndex, start: number, end: number): Promise<(WorkerLogItem | null)[]> {
  if (start >= end) return [];
  const from = ix.starts[start];
  const to = end < ix.starts.length ? ix.starts[end] : ix.size;
  const buf = Buffer.alloc(to - from);
  const fh = await fs.open(file, 'r');
  try {
    let got = 0;
    while (got < buf.length) {
      const { bytesRead } = await fh.read(buf, got, buf.length - got, from + got);
      if (!bytesRead) break;
      got += bytesRead;
    }
  } finally {
    await fh.close().catch(() => {});
  }
  return buf.toString('utf8').split('\n').filter(Boolean).slice(0, end - start).map((l) => {
    try { return JSON.parse(l) as WorkerLogItem; } catch { return null; }
  });
}

/** A page of a log: the last `limit` lines before line `before` (the end when absent). Lines that don't parse are skipped. */
export async function readLogPage(file: string, before: number | undefined, limit: number): Promise<LogPage> {
  try {
    const ix = await lineIndex(file);
    if (!ix) return { items: [], start: 0, total: 0 };
    const total = ix.starts.length;
    const { start, end } = pageBefore(total, before, limit);
    const items = (await readLines(file, ix, start, end)).filter((x): x is WorkerLogItem => x !== null);
    return { items, start, total };
  } catch {
    return { items: [], start: 0, total: 0 };
  }
}

/**
 * The newest `limit` lines of a log that match a query, newest first, read a batch at a time from the end. Events
 * ("ran a tool") are not something said; a hit's id is its line number in the log.
 */
export async function searchLog(file: string, where: string, query: string, limit: number): Promise<TextHit[]> {
  const out: TextHit[] = [];
  if (limit <= 0) return out;
  try {
    const ix = await lineIndex(file);
    if (!ix) return out;
    for (let end = ix.starts.length; end > 0 && out.length < limit; end -= SEARCH_BATCH) {
      const start = Math.max(0, end - SEARCH_BATCH);
      const lines = (await readLines(file, ix, start, end))
        .map((x) => (!x || x.from === 'event' ? { ts: x?.ts ?? '', text: '' } : x));
      out.push(...searchItems(lines, query, limit - out.length, (_x, i) => String(start + i), where));
    }
  } catch { /* an unreadable log has nothing to find */ }
  return out;
}

/** Forgets every index (tests). */
export function forgetLogIndexes() {
  indexes.clear();
}
