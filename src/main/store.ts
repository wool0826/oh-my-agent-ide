import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { isDeepStrictEqual } from 'node:util';
import { writeJsonAtomic, debounce, nowIso, ensureDir, uid, month } from './util';
import { backupDay, backupName, backupsNewestFirst, backupsToDrop, stateText, type BackupPart } from '../shared/backup';
import { SEARCH_MIN, searchItems, type TextHit } from '../shared/textSearch';
import { paths } from './paths';
import { addSpend, type SessionSpend, type Spend } from '../shared/spend';
import { PAGE, itemsBefore } from '../shared/paging';
import { CHAIN, STATE_VERSION, migrate, preMigrationName, stateVersion, type MigrationChain } from '../shared/migrate';
import {
  SPLIT, applySealed, chatOrder, chatToDrop, coverCounters, expected, foldLines, foldToLines, joinState, noneSealed, repairFold,
  sealedFrom, splitState, taskOrder, type Fold, type Sealed,
} from '../shared/stateSplit';
import { appendLines, asideName, readFold, copyAside, setAside, writeLines } from './stateFiles';
import { readLogPage, searchLog } from './logFile';
import { stampQueued } from '../shared/queue';
import { addSent, type SentPrompt } from '../shared/quickInput';
import { stampHistory } from '../shared/retro';
import { callers, moveLine, statusMoves } from '../shared/taskStatus';
import { log } from './log';
import { clearForeignPrs } from '../shared/prOwner';
import type { Memo, Automation, MergeQueueEntry, SavedPrompt, ShellScript } from '../shared/types';
import type { ChatEv } from '../shared/chatEvents';
import type { AutoAnswer, ChatItem, ChatKind, Decision, LogPage, MemorySuggestion, Repo, Task, TaskStatus, Worker, WorkerLogItem } from '../shared/types';

export interface DispatcherState {
  sessionId: string | null; date: string | null; contextTokens: number; accountId: string | null;
  /** Whose agent `sessionId` belongs to. Unset in older state files: Claude. */
  provider?: 'claude' | 'chatgpt';
  /** The Dispatcher's own spend (its sessions, the answer-on-your-behalf check and the memory-suggestion check) by month, YYYY-MM. */
  spend?: Record<string, Spend>;
  sessionSpend?: SessionSpend | null;
}

/**
 * The state as it is in memory. On disk state.json holds it without the tasks that ended and the older chat, which
 * are in two files beside it (shared/stateSplit.ts); `chat` here is the newest SPLIT.chatKeep items.
 */
export interface Data {
  version: number;
  counters: { worker: number; task: number };
  repos: Repo[];
  workers: Worker[];
  tasks: Task[];
  decisions: Decision[];
  autoAnswers: AutoAnswer[];
  /** "Remember this?" cards, answered ones too (see agents/memorySuggest.ts) */
  memorySuggestions: MemorySuggestion[];
  chat: ChatItem[];
  dispatcher: DispatcherState;
  /** Worker news the Dispatcher should hear on its next turn */
  pendingUpdates: string[];
  /** The user's memos (shared/memos.ts). Unset in state files saved before they existed. */
  memos?: Memo[];
  /** Automations (shared/automations.ts). Unset in state files saved before they existed. */
  automations?: Automation[];
  /** Saved shell scripts (shared/scripts.ts). Unset in state files saved before they existed. */
  scripts?: ShellScript[];
  /** Saved prompts (shared/prompts.ts). Unset in state files saved before they existed. */
  prompts?: SavedPrompt[];
  /** Paths the user attached to messages (see attachments.ts) */
  attachments?: string[];
  /** The merge queue (shared/mergeQueue.ts). Unset in state files saved before it existed. */
  mergeQueue?: MergeQueueEntry[];
  /** The phone channel: Telegram update ids already taken (remote/inbound.ts), saved with the chat lines they made. */
  remote?: { telegramSeen?: number[]; telegramHeld?: { text: string; replyTo: string | null; files?: string[] }[] };
  /** Prompts sent from each composer, newest first, by shared/quickInput.ts historyKey(). Unset before they existed. */
  history?: Record<string, SentPrompt[]>;
}

type ChatPage = { items: ChatItem[]; more: boolean };

const empty = (): Data => ({
  version: STATE_VERSION,
  counters: { worker: 0, task: 0 },
  repos: [], workers: [], tasks: [], decisions: [], autoAnswers: [], memorySuggestions: [], chat: [],
  dispatcher: { sessionId: null, date: null, contextTokens: 0, accountId: null },
  pendingUpdates: [],
});

class Store extends EventEmitter {
  data: Data = empty();

  /** Set by load() when the state file could not be read and a backup took its place: the day of that backup, or 'none'. */
  restoredFrom: string | null = null;
  /** load() has run. Before it `data` is the empty state, and saving that would replace the file on disk. */
  loaded = false;
  /**
   * Set by load() when the state must not be written this launch: the file was saved by a newer build (`newer`),
   * or a step bringing it to this build's format failed and the copy kept before it was put back (`failed`).
   */
  readOnly: { why: 'newer'; version: number } | { why: 'failed'; from: number; error: string } | null = null;
  /** Set by load() when the state was brought to this build's format: the version it had, and the copy kept of it. */
  migrated: { from: number; copy: string } | null = null;
  /**
   * Set by load() for each of the two appended files that had lost records: how many a backup gave back (and the
   * day of the newest backup that gave some), and how many are still missing.
   */
  repaired: { part: 'chat' | 'tasks'; restored: number; missing: number; day: string | null }[] = [];
  /** Lines of the two appended files that load() could not read and skipped. */
  skippedLines = 0;

  /** What chat.jsonl and tasks-done.jsonl hold, as last written or read: a record that differs from its line is appended again. */
  private sealed: Sealed = noneSealed();
  /** The chat in chat.jsonl that is older than the chat in memory, kept for a minute after a page or a search read it. */
  private older: { key: string; items: Promise<ChatItem[]> } | null = null;

  /**
   * Reads the state. A file that holds something unreadable is set aside (never overwritten), and the newest
   * backup that can be read takes its place; with none, the app starts empty and says so. From version 2 on,
   * state.json is put together with the two files beside it. A state saved in an older format is brought up to
   * this one (shared/migrate.ts) after a copy of it is kept.
   */
  load(chain: MigrationChain = CHAIN) {
    const p = paths();
    const file = p.state;
    let text: string | null = null;
    this.restoredFrom = null;
    try { text = fs.readFileSync(file, 'utf8'); } catch { /* a first run */ }
    if (stateText(text) === 'broken') {
      const aside = path.join(paths().data, `state-broken-${Date.now()}.json`);
      try { fs.copyFileSync(file, aside); } catch { /* kept where it is */ }
      this.restoredFrom = 'none';
      text = null;
      let names: string[] = [];
      try { names = fs.readdirSync(paths().backups); } catch { /* no backups yet */ }
      for (const name of backupsNewestFirst(names)) {
        let candidate: string;
        try { candidate = fs.readFileSync(path.join(paths().backups, name), 'utf8'); } catch { continue; }
        if (stateText(candidate) !== 'ok') continue;
        text = candidate;
        this.restoredFrom = name.replace(/^state-|\.json$/g, '');
        break;
      }
    }
    this.readOnly = null;
    this.migrated = null;
    this.repaired = [];
    this.skippedLines = 0;
    this.sealed = noneSealed();
    this.older = null;
    const had = text !== null && stateText(text) === 'ok';
    let raw = had ? (JSON.parse(text!.replace(/^\uFEFF/, '')) as Record<string, unknown>) : {};
    const onDisk = stateVersion(raw);
    // The two files count when state.json is of a version that has them, when it is gone (they are all that is
    // left), or when a backup from before them took its place (they hold what was saved after that day). Beside
    // a version 1 file that was read as it is, they are what a first split that never finished left behind.
    const files = [p.chatFile, p.tasksDone].some((f) => fs.existsSync(f));
    const joined = had ? onDisk >= SPLIT.version || (!!this.restoredFrom && files) : files;
    if (joined) raw = this.join(raw, onDisk <= chain.version);
    if (had) raw = this.upgrade(raw, text!, chain);
    this.data = coverCounters({ ...empty(), ...raw }) as unknown as Data;
    this.loaded = true;
    // A PR a report only cited was once recorded as the task's (T-0150): it is dropped, and the task is done again.
    const cleared = Array.isArray(this.data.tasks) ? clearForeignPrs(this.data.tasks, Array.isArray(this.data.repos) ? this.data.repos : []) : [];
    if (cleared.length) log.info(`dropped PRs from other repositories or tasks without a branch: ${cleared.join(', ')}`);
    // What the tasks' statuses are now, so only later changes are logged (a state that cannot be read has no list).
    this.seenStatus.clear();
    if (Array.isArray(this.data.tasks)) statusMoves(this.seenStatus, this.data.tasks);
    const from = (this.migrated as { from: number } | null)?.from; // set by upgrade()
    if (!this.readOnly && from !== undefined && from < SPLIT.version) {
      try {
        this.firstSplit(joined);
      } catch (e) {
        // state.json was not written, so the state is still the one file it was.
        this.readOnly = { why: 'failed', from, error: e instanceof Error ? e.message : String(e) };
        this.migrated = null;
        this.sealed = noneSealed();
      }
      this.dropOldChat();
      return;
    }
    this.dropOldChat(joined ? this.sealed.chatCount : 0);
    if ((this.restoredFrom || this.migrated || this.repaired.length || cleared.length) && !this.readOnly) this.flush();
  }

  /**
   * state.json put together with the two files beside it. A file that holds fewer records than state.json counted
   * when it was last written has lost some: with `repair` they are taken from the backups, newest first.
   */
  private join(main: Record<string, unknown>, repair: boolean): Record<string, unknown> {
    const p = paths();
    let tasks = readFold<Task>(p.tasksDone);
    let chat = readFold<ChatItem>(p.chatFile);
    this.skippedLines = tasks.bad + chat.bad;
    if (repair) {
      const want = expected(main);
      if (tasks.items.length < want.tasks) tasks = this.repair('tasks', p.tasksDone, 'tasks-done', tasks, want.tasks, taskOrder);
      if (chat.items.length < want.chat) chat = this.repair('chat', p.chatFile, 'chat', chat, want.chat, chatOrder);
    }
    this.sealed = sealedFrom(tasks, chat);
    return joinState(main, tasks, chat);
  }

  /**
   * A file that lost records, with the ones the backups still have. The file as it was found is kept beside it
   * ("chat-broken-<time>.jsonl") and written anew; if that cannot be done, it is used as it is.
   */
  private repair<T extends { id: string }>(part: 'chat' | 'tasks', file: string, name: BackupPart, found: Fold<T>, want: number, order: (a: T, b: T) => number): Fold<T> {
    let fold = found;
    let restored = 0;
    let day: string | null = null;
    let names: string[] = [];
    try { names = fs.readdirSync(paths().backups); } catch { /* no backups yet */ }
    for (const n of backupsNewestFirst(names, name)) {
      if (fold.items.length >= want) break;
      const r = repairFold(fold, readFold<T>(path.join(paths().backups, n)), order);
      if (r.restored) day ??= backupDay(n);
      fold = r.fold;
      restored += r.restored;
    }
    if (restored) {
      try {
        if (fs.existsSync(file)) fs.copyFileSync(file, asideName(file, 'broken', Date.now()));
        writeLines(file, foldToLines(fold));
      } catch {
        fold = found;
        restored = 0;
        day = null;
      }
    }
    this.repaired.push({ part, restored, missing: Math.max(0, want - fold.items.length), day });
    return fold;
  }

  /**
   * The first save in the split layout, from a state that was one file. The two files are written whole and read
   * back: only when they and the new state.json give the state in memory again does state.json change, so until
   * then the old file is still all there is to read and a start after a stop anywhere here begins again. Files left
   * by such a stop are set aside first ("chat-before-v2-<time>.jsonl"). Files that were read into this state
   * (`readIn`: a backup from before the split took the place of state.json) hold records nothing else has, so they
   * are only copied and stay until the new ones take their names; when the split fails they are put back.
   */
  private firstSplit(readIn: boolean) {
    const p = paths();
    const now = Date.now();
    const files = [p.chatFile, p.tasksDone];
    const aside = files.map((f) => (readIn ? copyAside : setAside)(f, 'before-v2', now));
    const split = splitState(this.data, noneSealed(), now);
    try {
      writeLines(p.tasksDone, split.taskLines);
      writeLines(p.chatFile, split.chatLines);
      const back = joinState(JSON.parse(JSON.stringify(split.main)), readFold<Task>(p.tasksDone), readFold<ChatItem>(p.chatFile));
      if (!isDeepStrictEqual(back, JSON.parse(JSON.stringify(this.data)))) throw new Error('the files written did not read back as the state');
      writeJsonAtomic(p.state, split.main);
    } catch (e) {
      files.forEach((f, i) => {
        const was = readIn ? aside[i] : null;
        try {
          if (was) fs.renameSync(was, f);
          else fs.rmSync(f, { force: true });
        } catch { /* the file was never replaced, so it is still the one that was read */ }
      });
      throw e;
    }
    this.sealed = noneSealed();
    applySealed(this.sealed, split, 'tasks');
    applySealed(this.sealed, split, 'chat');
  }

  /**
   * Memory holds the newest chat only. What leaves is in chat.jsonl: the first `fromFile` items right after a
   * start, later the ones a save wrote there. Read-only, nothing is saved, so the oldest just go.
   */
  private dropOldChat(fromFile = 0) {
    const chat = this.data.chat;
    const over = chat.length - SPLIT.chatKeep;
    const n = this.readOnly ? over : Math.max(Math.min(over, fromFile), chatToDrop(chat, this.sealed));
    if (n > 0) for (const c of chat.splice(0, n)) this.sealed.chat.delete(c.id);
  }

  /**
   * The state in this build's format. Before the first step a copy of the text read is kept in the data folder;
   * when a step fails that copy is put back as the state file and the state is opened read-only as it was, and a
   * state from a newer build is opened read-only, so neither is written over.
   */
  private upgrade(raw: Record<string, unknown>, text: string, chain: MigrationChain): Record<string, unknown> {
    const file = paths().state;
    const r = migrate(raw, chain);
    if (r.kind === 'current') return raw;
    if (r.kind === 'newer') {
      this.readOnly = { why: 'newer', version: r.version };
      return raw;
    }
    const from = r.from;
    const copy = path.join(paths().data, preMigrationName(from, chain.version, Date.now()));
    try {
      fs.writeFileSync(copy, text);
    } catch (e) {
      this.readOnly = { why: 'failed', from, error: `the copy could not be kept: ${e instanceof Error ? e.message : String(e)}` };
      return raw;
    }
    if (r.kind === 'migrated') {
      this.migrated = { from, copy };
      return r.state;
    }
    // A state restored from a backup leaves the unreadable file where it is (its copy aside may have failed).
    if (!this.restoredFrom) try { fs.copyFileSync(copy, file); } catch { /* the file was not written yet, so it still holds the same text */ }
    this.readOnly = { why: 'failed', from, error: r.error };
    return raw;
  }

  /**
   * Once a day, the state as it is on disk (state.json and the two files beside it) is copied to data/backups,
   * and the oldest copies beyond a week go. Called at launch and every hour; a file that already has the day's
   * copy is left alone.
   */
  backup(now = new Date()) {
    try {
      const p = paths();
      const dir = p.backups;
      ensureDir(dir);
      let made = false;
      const copies: [BackupPart, string][] = [['state', p.state], ['chat', p.chatFile], ['tasks-done', p.tasksDone]];
      for (const [part, file] of copies) {
        const target = path.join(dir, backupName(now, part));
        if (fs.existsSync(target)) continue;
        try {
          if (part === 'state') {
            const text = fs.readFileSync(file, 'utf8');
            if (stateText(text) !== 'ok') continue; // never keep a copy of a file that cannot be read
            fs.writeFileSync(target, text);
          } else fs.copyFileSync(file, target);
          made = true;
        } catch { /* no such file yet */ }
      }
      if (made) for (const old of backupsToDrop(fs.readdirSync(dir))) fs.rmSync(path.join(dir, old), { force: true });
    } catch { /* a backup that fails must not stop the app */ }
  }

  private persist = debounce(() => this.flush(), 300);

  /** Each task's status when changed() last ran, to log the moves (logMoves). */
  private seenStatus = new Map<string, TaskStatus>();

  changed() {
    stampQueued(this.data.tasks);
    stampHistory(this.data.tasks, nowIso());
    this.logMoves();
    this.persist();
    this.emit('changed');
  }

  /** Every change of a task's status goes to the app log, with whether it has a PR and the code that changed it. */
  private logMoves() {
    const moves = statusMoves(this.seenStatus, this.data.tasks);
    if (!moves.length) return;
    const via = callers(new Error().stack ?? '', 'logMoves');
    for (const x of moves) log.info(moveLine(x, via));
  }

  /**
   * Writes the state now: first the lines for the two appended files (tasks that ended, chat that left the tail,
   * records that changed since their line), then state.json without them. In that order a record is never in
   * neither, wherever the app stops. Nothing is written while it is read-only.
   */
  flush() {
    if (this.readOnly) return;
    const p = paths();
    const split = splitState(this.data, this.sealed, Date.now());
    appendLines(p.tasksDone, split.taskLines);
    applySealed(this.sealed, split, 'tasks');
    appendLines(p.chatFile, split.chatLines);
    applySealed(this.sealed, split, 'chat');
    writeJsonAtomic(p.state, split.main);
    this.dropOldChat();
  }

  nextWorkerId() {
    this.data.counters.worker += 1;
    return `W-${String(this.data.counters.worker).padStart(2, '0')}`;
  }

  nextTaskId() {
    this.data.counters.task += 1;
    return `T-${String(this.data.counters.task).padStart(4, '0')}`;
  }

  worker(id: string) { return this.data.workers.find((w) => w.id === id) ?? null; }
  task(id: string) { return this.data.tasks.find((t) => t.id === id) ?? null; }
  repo(name: string) { return this.data.repos.find((r) => r.name.toLowerCase() === name.toLowerCase()) ?? null; }

  /** The prompts sent from one composer (shared/quickInput.ts historyKey()), newest first. */
  sentPrompts(key: string): SentPrompt[] {
    return this.data.history?.[key] ?? [];
  }

  /** A prompt went from a composer. The lists of Workers that are gone are dropped with it. */
  addSentPrompt(key: string, text: string) {
    const all = (this.data.history ??= {});
    all[key] = addSent(all[key] ?? [], text, nowIso());
    for (const k of Object.keys(all)) if (k.startsWith('w:') && !this.worker(k.slice(2))) delete all[k];
    this.changed();
  }

  chat(kind: ChatKind, text: string, ref?: string, replyTo?: string | null) {
    const item: ChatItem = { id: uid(), ts: nowIso(), kind, text, ref };
    if (replyTo) item.replyTo = replyTo;
    this.data.chat.push(item);
    // The oldest leave memory when a save has put them in the file (flush); read-only, nothing is saved.
    if (this.readOnly) this.dropOldChat();
    this.changed();
    // Told after the caller has finished the item (an event gets its parts right after), for the phone channel.
    if (kind === 'error') queueMicrotask(() => this.emit('chat-error', item));
    return item;
  }

  /** An event line with its parts, which the thread draws as one row (shared/chatEvents.ts). */
  event(text: string, ev: ChatEv, opts: { kind?: 'event' | 'error'; ref?: string } = {}) {
    const item = this.chat(opts.kind ?? 'event', text, opts.ref);
    item.ev = ev;
    return item;
  }

  /** A Worker made or a task handed out (`ref`: the task): the chat folds these into one block (shared/handouts.ts). */
  handout(text: string, ref?: string) {
    const item = this.chat('event', text, ref);
    item.sub = 'handout';
    return item;
  }

  log(workerId: string, from: WorkerLogItem['from'], text: string, task?: string) {
    const item: WorkerLogItem = { ts: nowIso(), from, text, ...(task ? { task } : {}) };
    ensureDir(paths().workerLogs);
    fs.appendFileSync(path.join(paths().workerLogs, `${workerId}.jsonl`), JSON.stringify(item) + '\n', 'utf8');
    this.emit('workerLog', workerId, item);
  }

  /**
   * A page of a Worker's log: the last `limit` lines before line `before` (the end when absent). Lines that don't
   * parse are skipped. Only the page's lines are read (main/logFile.ts).
   */
  readLog(workerId: string, before?: number, limit: number = PAGE.log): Promise<LogPage> {
    return readLogPage(path.join(paths().workerLogs, `${workerId}.jsonl`), before, limit);
  }

  /** Chat items chat.jsonl holds that are no longer in memory. */
  private get olderCount() {
    return this.sealed.chatCount - this.sealed.chat.size;
  }

  /** Those items, oldest first: the file is read whole, off the main thread's path, and kept for a minute. */
  private olderChat(): Promise<ChatItem[]> {
    const key = `${this.sealed.chatCount}:${this.data.chat[0]?.id ?? ''}`;
    if (this.older?.key === key) return this.older.items;
    const here = new Set(this.data.chat.map((c) => c.id));
    const items = fs.promises.readFile(paths().chatFile, 'utf8').then((text) => foldLines<ChatItem>(text).items.filter((c) => !here.has(c.id)), () => []);
    const held = { key, items };
    this.older = held;
    setTimeout(() => { if (this.older === held) this.older = null; }, 60_000).unref();
    return items;
  }

  /**
   * What was said that matches a query: the chat with the Dispatcher (what the user and it said) and each Worker's
   * conversation, newest first. The chat in memory is searched first, then the older chat in chat.jsonl. Workers
   * that are not archived are read first; a Worker gives a few lines at most, read from the end of its log.
   */
  async searchText(query: string, limit = 24): Promise<TextHit[]> {
    if (query.trim().length < SEARCH_MIN) return [];
    const said = (c: ChatItem) => c.kind === 'user' || c.kind === 'dispatcher';
    const half = Math.ceil(limit / 2);
    const out = searchItems(this.data.chat.filter(said), query, half, (c) => c.id, 'chat');
    if (out.length < half && this.olderCount > 0) out.push(...searchItems((await this.olderChat()).filter(said), query, half - out.length, (c) => c.id, 'chat'));
    const workers = [...this.data.workers].sort((a, b) => Number(a.status === 'archived') - Number(b.status === 'archived') || b.lastActiveAt.localeCompare(a.lastActiveAt));
    for (const w of workers) {
      if (out.length >= limit) break;
      out.push(...await searchLog(path.join(paths().workerLogs, `${w.id}.jsonl`), w.id, query, Math.min(4, limit - out.length)));
    }
    return out.slice(0, limit);
  }

  /**
   * Up to `limit` chat items right before the one with id `before`, and whether there are more. A page that
   * reaches past the chat in memory is read from chat.jsonl.
   */
  async chatPage(before: string, limit: number = PAGE.chat): Promise<ChatPage> {
    const page = itemsBefore(this.data.chat, before, limit);
    if (this.olderCount <= 0) return page;
    // A full page from memory is the page; whether there is more before it is the file's to say.
    if (page.items.length === limit) return { ...page, more: true };
    return itemsBefore([...(await this.olderChat()), ...this.data.chat], before, limit);
  }

  /** Count Dispatcher spend for this month; it is kept apart from task spend. */
  dispatcherSpent(s: Spend) {
    const d = this.data.dispatcher;
    d.spend = { ...d.spend, [month()]: addSpend(d.spend?.[month()], s) };
    this.changed();
  }

  /**
   * Worker news for the Dispatcher. It goes with the Dispatcher's next message; with `wake` it is worth a turn
   * of its own, so the Dispatcher starts one by itself (see Dispatcher.wake).
   */
  pushUpdate(text: string, wake = false, report?: string) {
    this.data.pendingUpdates.push(text);
    if (wake && report) this.reports.push(report);
    if (this.data.pendingUpdates.length > 50) this.data.pendingUpdates.splice(0, this.data.pendingUpdates.length - 50);
    this.changed();
    if (wake) this.emit('wake');
  }

  /**
   * Tasks whose report (result or failure) is among the pending updates, so the turn they start answers it
   * (shared/thread.ts). Kept in memory only: after a restart the turn's messages are simply top level.
   */
  private reports: string[] = [];

  takeReports(): string[] {
    return this.reports.splice(0);
  }

  takeUpdates(): string[] {
    const u = this.data.pendingUpdates.splice(0);
    // Shell runs waiting for this turn: the Dispatcher has them now (main/shell.ts).
    for (const c of this.data.chat.slice(-200)) if (c.shell?.sent === 'queued') c.shell.sent = 'sent';
    if (u.length) this.changed();
    return u;
  }
}

export const store = new Store();

/**
 * Writes the state now, without waiting for the debounce, for an error nothing caught (crash.ts). Nothing is written
 * before the state was read, and a write that fails is reported, not thrown.
 */
export function flushNow(): boolean {
  if (!store.loaded || store.readOnly) return false;
  try { store.flush(); return true; } catch { return false; }
}
