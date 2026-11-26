// The files beside state.json that hold chat and finished tasks, one record a line (shared/stateSplit.ts says what
// goes into them and how they read back). Nothing here knows the app's folders: the store passes the paths.

import fs from 'node:fs';
import path from 'node:path';
import { emptyFold, expected, foldLines, joinState, toV1, type Fold } from '../shared/stateSplit';
import { stateVersion } from '../shared/migrate';
import { stateText } from '../shared/backup';
import type { ChatItem, Task } from '../shared/types';

/** A file's records. One that is not there has none. */
export function readFold<T extends { id: string }>(file: string): Fold<T> {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return emptyFold<T>(); }
  return foldLines<T>(text);
}

/**
 * Adds lines to the end of a file and waits until they are on the disk, so the state.json written after them never
 * counts on lines that a power cut could still take. A file left without its last line end (the app stopped half
 * way through a line) gets one first, so the cut-off line is skipped alone and not with the first new one.
 */
export function appendLines(file: string, lines: readonly string[]): void {
  if (!lines.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'a+');
  try {
    const size = fs.fstatSync(fd).size;
    let lead = '';
    if (size > 0) {
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 0x0a) lead = '\n';
    }
    fs.writeSync(fd, `${lead}${lines.join('\n')}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Writes a file whole: to a temp file that is on the disk before it takes the name. */
export function writeLines(file: string, lines: readonly string[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, lines.length ? `${lines.join('\n')}\n` : '');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/** The name "chat.jsonl" gets beside itself: "chat-<tag>-<now>.jsonl". */
export function asideName(file: string, tag: string, now: number): string {
  const ext = path.extname(file);
  return path.join(path.dirname(file), `${path.basename(file, ext)}-${tag}-${now}${ext}`);
}

/** Moves a file to its name aside and gives that name; null when there is no such file. */
export function setAside(file: string, tag: string, now: number): string | null {
  if (!fs.existsSync(file)) return null;
  const to = asideName(file, tag, now);
  fs.renameSync(file, to);
  return to;
}

/** The same, but the file stays where it is too. */
export function copyAside(file: string, tag: string, now: number): string | null {
  if (!fs.existsSync(file)) return null;
  const to = asideName(file, tag, now);
  fs.copyFileSync(file, to);
  return to;
}

export interface StatePaths { state: string; chatFile: string; tasksDone: string }

export type Rollback =
  /** state.json is one file of version 1 again; the files it was put together from are kept under these names. */
  | { kind: 'done'; kept: string[]; tasks: number; chat: number }
  /**
   * Nothing to do, or nothing that may be done: no state, one that is version 1 already, one that cannot be read, one
   * from a newer build, or files that hold fewer records than state.json counts (`short`: a start of the app puts
   * them back from the backups first; written back as they are, the one file would be without them).
   */
  | { kind: 'none'; why: 'missing' | 'v1' | 'broken' | 'newer' | 'short'; version?: number };

/**
 * The way back to a build that reads one file (`--state-v1`): the three files are put together and written as
 * state.json in version 1, with everything in it. state.json as it was and the two files stay beside it under
 * "…-before-v1-<now>" names, so nothing is thrown away and the next start of a newer build splits it again.
 */
export function rollbackToV1(p: StatePaths, now = Date.now()): Rollback {
  let text: string | null = null;
  try { text = fs.readFileSync(p.state, 'utf8'); } catch { /* no state file */ }
  const what = stateText(text);
  if (what === 'empty') return { kind: 'none', why: 'missing' };
  if (what === 'broken') return { kind: 'none', why: 'broken' };
  const main = JSON.parse(text!.replace(/^﻿/, '')) as Record<string, unknown>;
  const version = stateVersion(main);
  if (version === 1) return { kind: 'none', why: 'v1' };
  if (version > 2) return { kind: 'none', why: 'newer', version };
  const tasks = readFold<Task>(p.tasksDone);
  const chat = readFold<ChatItem>(p.chatFile);
  const want = expected(main);
  if (tasks.items.length < want.tasks || chat.items.length < want.chat) return { kind: 'none', why: 'short' };
  const whole = toV1(joinState(main, tasks, chat));
  const kept = [asideName(p.state, 'v2-before-v1', now)];
  fs.copyFileSync(p.state, kept[0]);
  const tmp = `${p.state}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(whole, null, 2), 'utf8');
  fs.renameSync(tmp, p.state);
  for (const file of [p.chatFile, p.tasksDone]) {
    const to = setAside(file, 'before-v1', now);
    if (to) kept.push(to);
  }
  return { kind: 'done', kept, tasks: (whole.tasks as unknown[]).length, chat: (whole.chat as unknown[]).length };
}
