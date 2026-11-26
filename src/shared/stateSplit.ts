// Where the saved state lives from version 2 on (decision 213). state.json keeps what is live; chat that has left
// its tail and tasks that ended go to two files that are only ever appended to (chat.jsonl, tasks-done.jsonl), one
// record a line. Pure: main/store.ts reads and writes the files and asks here what goes where (splitState), how
// the three read back as one state (joinState), and what a damaged file gets back from a backup (repairFold).
//
// A line is a record ({"id": ...}: a later line with the same id takes its place, where the first one stood) or
// {"$open": id} (a finished task went back to work, so the one in state.json counts). Anything else is skipped.
// The store appends first and writes state.json last, so a record is never in neither file; one found in both is
// taken from the appended file.

import type { ChatItem, Task } from './types';

export const SPLIT = {
  /** The first state version with this layout. */
  version: 2,
  /** state.json keeps the newest chat: once it holds more than `tailMax` items, all but the newest `tailMin` move out. */
  tailMax: 100,
  tailMin: 50,
  /** A task moves out this long after it ended and last changed: right after, its summary, spend and files still do. */
  settle: 10 * 60_000,
  /** Chat items held in memory; older ones are read from the file. */
  chatKeep: 2000,
} as const;

/** The app argument that writes the state back as the one file version 1 was, and quits (main/stateFiles.ts). */
export const V1_ARG = '--state-v1';

const OPEN = '$open';
/** `Sealed.tasks`: the file's last word on this task is that it went back to work. */
const REOPENED = '';

type Rec = { id: string };
const usable = (id: unknown): id is string => typeof id === 'string' && id !== '';
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/** What an appended file says, read from its first line to its last. */
export interface Fold<T extends Rec> {
  /** Each record as its last readable line, in the order the ids first appeared. */
  items: T[];
  /** Tasks whose last line says they went back to work. */
  open: Set<string>;
  /** Lines that could not be read. */
  bad: number;
}

export const emptyFold = <T extends Rec>(): Fold<T> => ({ items: [], open: new Set(), bad: 0 });

export function foldLines<T extends Rec>(text: string): Fold<T> {
  const items: T[] = [];
  const at = new Map<string, number>();
  const open = new Set<string>();
  let bad = 0;
  for (const raw of text.replace(/^\uFEFF/, '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let v: unknown;
    try { v = JSON.parse(line); } catch { bad += 1; continue; }
    if (!isRecord(v)) { bad += 1; continue; }
    const marked = v[OPEN];
    if (usable(marked)) { if (at.has(marked)) open.add(marked); continue; }
    if (!usable(v.id)) { bad += 1; continue; }
    const i = at.get(v.id);
    if (i === undefined) { at.set(v.id, items.length); items.push(v as T); } else items[i] = v as T;
    open.delete(v.id);
  }
  return { items, open, bad };
}

/** The lines that read back as this fold: what a file put together again is written as. */
export function foldToLines<T extends Rec>(fold: Fold<T>): string[] {
  return [...fold.items.map((x) => JSON.stringify(x)), ...[...fold.open].map((id) => JSON.stringify({ [OPEN]: id }))];
}

/** What the two files hold, as the store last wrote or read it: a record that differs from its line is appended again. */
export interface Sealed {
  /** Tasks in tasks-done.jsonl: the line last written, or '' after its `$open` line. */
  tasks: Map<string, string>;
  /** The chat items in memory that are in chat.jsonl: the line last written. */
  chat: Map<string, string>;
  /** Records chat.jsonl holds in all, those no longer in memory too. */
  chatCount: number;
}

export const noneSealed = (): Sealed => ({ tasks: new Map(), chat: new Map(), chatCount: 0 });

/** `Sealed` for files just read. Only the newest `keep` chat items can be in memory, so only they are tracked. */
export function sealedFrom(tasks: Fold<Task>, chat: Fold<ChatItem>, keep: number = SPLIT.chatKeep): Sealed {
  return {
    tasks: new Map(tasks.items.map((x) => [x.id, tasks.open.has(x.id) ? REOPENED : JSON.stringify(x)])),
    chat: new Map(chat.items.slice(-keep).map((c) => [c.id, JSON.stringify(c)])),
    chatCount: chat.items.length,
  };
}

const FINISHED: ReadonlySet<string> = new Set(['done', 'failed', 'cancelled']);

const time = (s: unknown): number => {
  const n = typeof s === 'string' ? Date.parse(s) : NaN;
  return Number.isNaN(n) ? -Infinity : n;
};

/** It ended, and nothing about it changed for a while. One without a time that can be read counts as long ended. */
function settled(task: Task, now: number): boolean {
  return now - Math.max(time(task.finishedAt), time(task.updatedAt)) >= SPLIT.settle;
}

/** A shell run that still changes: while it runs, and until the Dispatcher took its result. */
const live = (c: ChatItem) => !!c.shell && (c.shell.running || c.shell.sent === 'wait' || c.shell.sent === 'queued');

/** The ids that name one record of a list and no other: only those can be told apart in a file. */
function singles(items: readonly { id?: unknown }[]): Set<string> {
  const n = new Map<string, number>();
  for (const x of items) if (usable(x?.id)) n.set(x.id, (n.get(x.id) ?? 0) + 1);
  return new Set([...n].filter(([, c]) => c === 1).map(([id]) => id));
}

export interface Split<S> {
  /** What state.json gets: the state without what the files hold, and how many records they should hold (`sealed`). */
  main: S & { sealed: { chat: number; tasks: number } };
  /** Lines to append to tasks-done.jsonl and chat.jsonl before state.json is written. */
  taskLines: string[];
  chatLines: string[];
  /** What those lines change in `Sealed` once they are in their files (applySealed). */
  tasks: [id: string, line: string][];
  chat: [id: string, line: string][];
  chatAdded: number;
}

/**
 * What a save writes. Tasks that ended and settled leave state.json; one that changed since its line was written
 * gets a new line, and one that went back to work gets an `$open` line and is in state.json again. Chat leaves
 * oldest first once the tail is too long, never past a shell run that still changes, so the file stays in the
 * order things were said. Records without an id of their own stay in state.json.
 */
export function splitState<S extends { tasks: Task[]; chat: ChatItem[] }>(state: S, sealed: Sealed, now: number): Split<S> {
  const taskLines: string[] = [];
  const taskSet: [string, string][] = [];
  const mainTasks: Task[] = [];
  const ownTask = singles(state.tasks);
  for (const t of state.tasks) {
    const mine = ownTask.has(t.id);
    const was = mine ? sealed.tasks.get(t.id) : undefined;
    if (mine && FINISHED.has(t.status) && (was || settled(t, now))) {
      const line = JSON.stringify(t);
      if (line !== was) { taskLines.push(line); taskSet.push([t.id, line]); }
      continue;
    }
    mainTasks.push(t);
    if (was) { taskLines.push(JSON.stringify({ [OPEN]: t.id })); taskSet.push([t.id, REOPENED]); }
  }

  const chatLines: string[] = [];
  const chatSet: [string, string][] = [];
  const ownChat = singles(state.chat);
  const tail: ChatItem[] = [];
  for (const c of state.chat) {
    const was = ownChat.has(c.id) ? sealed.chat.get(c.id) : undefined;
    if (was === undefined) { tail.push(c); continue; }
    const line = JSON.stringify(c);
    if (line !== was) { chatLines.push(line); chatSet.push([c.id, line]); }
  }
  let mainChat = tail;
  let moved = 0;
  if (tail.length > SPLIT.tailMax) {
    const want = tail.length - SPLIT.tailMin;
    const stay: ChatItem[] = [];
    let i = 0;
    for (; i < tail.length && moved < want; i++) {
      const c = tail[i];
      if (live(c)) break;
      if (!ownChat.has(c.id)) { stay.push(c); continue; }
      const line = JSON.stringify(c);
      chatLines.push(line);
      chatSet.push([c.id, line]);
      moved += 1;
    }
    mainChat = [...stay, ...tail.slice(i)];
  }

  const taskRecords = sealed.tasks.size + taskSet.filter(([id]) => !sealed.tasks.has(id)).length;
  return {
    main: { ...state, tasks: mainTasks, chat: mainChat, sealed: { chat: sealed.chatCount + moved, tasks: taskRecords } },
    taskLines, chatLines, tasks: taskSet, chat: chatSet, chatAdded: moved,
  };
}

/** The lines of one file are in it: remember them. */
export function applySealed<S>(sealed: Sealed, split: Split<S>, part: 'tasks' | 'chat'): void {
  if (part === 'tasks') for (const [id, line] of split.tasks) sealed.tasks.set(id, line);
  else {
    for (const [id, line] of split.chat) sealed.chat.set(id, line);
    sealed.chatCount += split.chatAdded;
  }
}

/** How many of the oldest chat items can leave memory: those beyond `keep` that are in the file. */
export function chatToDrop(chat: readonly ChatItem[], sealed: Sealed, keep: number = SPLIT.chatKeep): number {
  let n = 0;
  while (chat.length - n > keep && sealed.chat.has(chat[n].id)) n += 1;
  return n;
}

const taskNumber = (t: { id?: unknown }): number => {
  const m = usable(t?.id) ? /^T-(\d+)$/.exec(t.id) : null;
  return m ? Number(m[1]) : Infinity;
};

/** Tasks in the order they were made: by the number in the id, the ones without a number last. */
export const taskOrder = (a: { id?: unknown }, b: { id?: unknown }): number => {
  const x = taskNumber(a), y = taskNumber(b);
  return x === y ? 0 : x < y ? -1 : 1;
};

/** Chat in the order it was said. */
export const chatOrder = (a: { ts?: unknown }, b: { ts?: unknown }): number => {
  const x = String(a.ts ?? ''), y = String(b.ts ?? '');
  return x === y ? 0 : x < y ? -1 : 1;
};

/** The task counter is never behind the ids in use, so a state.json from an older day cannot hand an id out twice. */
export function coverCounters<S extends Record<string, unknown>>(state: S): S {
  const c = state.counters;
  if (!isRecord(c) || typeof c.task !== 'number') return state;
  let max = c.task;
  for (const t of list<{ id?: unknown }>(state.tasks)) {
    const n = taskNumber(t);
    if (n !== Infinity && n > max) max = n;
  }
  return max === c.task ? state : { ...state, counters: { ...c, task: max } };
}

/**
 * The whole state from the three files. A task that is in both is taken from tasks-done.jsonl (state.json was
 * about to drop it when the app stopped, or is from an older day) unless its last line there says it went back to
 * work; a chat item in both is taken from chat.jsonl. Nothing found in either file is left out.
 */
export function joinState(main: Record<string, unknown>, tasks: Fold<Task>, chat: Fold<ChatItem>): Record<string, unknown> {
  const { sealed: _counts, ...rest } = main;
  const filed = new Set(tasks.items.map((x) => x.id));
  const kept = list<Task>(main.tasks).filter((t) => !(usable(t?.id) && filed.has(t.id) && !tasks.open.has(t.id)));
  const here = new Set(kept.map((t) => t?.id));
  const allTasks = [...kept, ...tasks.items.filter((t) => !here.has(t.id))].sort(taskOrder);
  const said = new Set(chat.items.map((c) => c.id));
  const allChat = [...chat.items, ...list<ChatItem>(main.chat).filter((c) => !said.has(c?.id))];
  return coverCounters({ ...rest, tasks: allTasks, chat: allChat });
}

/** The records state.json expects in each file (`sealed`, written with it); 0 when it says nothing. */
export function expected(main: Record<string, unknown>): { chat: number; tasks: number } {
  const s = isRecord(main.sealed) ? main.sealed : {};
  const n = (v: unknown) => (typeof v === 'number' && v > 0 ? v : 0);
  return { chat: n(s.chat), tasks: n(s.tasks) };
}

/**
 * A file that lost records gets back from a backup of it the ones it no longer has; what it still has is newer and
 * stays. `order` puts them back in their place (taskOrder, chatOrder).
 */
export function repairFold<T extends Rec>(file: Fold<T>, backup: Fold<T>, order: (a: T, b: T) => number): { fold: Fold<T>; restored: number } {
  const have = new Set(file.items.map((x) => x.id));
  const extra = backup.items.filter((x) => !have.has(x.id));
  if (!extra.length) return { fold: file, restored: 0 };
  const back = new Set(extra.map((x) => x.id));
  return {
    fold: {
      items: [...file.items, ...extra].sort(order),
      open: new Set([...file.open, ...[...backup.open].filter((id) => back.has(id))]),
      bad: 0,
    },
    restored: extra.length,
  };
}

/** The state as version 1 kept it: everything in one file. */
export function toV1<S extends object>(whole: S): S & { version: 1 } {
  return { ...whole, version: 1 };
}

/**
 * The step from version 1 to 2 (shared/migrate.ts). The data does not change shape in memory; the files do, when
 * the store first saves. What it checks is that the two lists are lists of records, and it gives chat items that
 * have no id of their own one, so each can be told apart in the file.
 */
export function toSplit(state: Record<string, unknown>): void {
  for (const key of ['tasks', 'chat']) {
    const v = state[key];
    if (v === undefined || v === null) { state[key] = []; continue; }
    if (!Array.isArray(v)) throw new Error(`"${key}" is not a list`);
    if (!v.every(isRecord)) throw new Error(`"${key}" holds something that is not a record`);
  }
  // The files give tasks back in the order of their numbers, which is the order they are in unless a file was
  // edited by hand: put them so now, and what is read back can be compared with what was there.
  (state.tasks as Record<string, unknown>[]).sort(taskOrder);
  const chat = state.chat as Record<string, unknown>[];
  const taken =new Set(chat.map((c) => c.id).filter(usable));
  const seen = new Set<string>();
  chat.forEach((c, i) => {
    if (usable(c.id) && !seen.has(c.id)) { seen.add(c.id); return; }
    let id = `old-${i}`;
    for (let n = 1; taken.has(id) || seen.has(id); n++) id = `old-${i}-${n}`;
    c.id = id;
    seen.add(id);
  });
}
