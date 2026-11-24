import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { readJson, writeJsonAtomic, debounce, nowIso, ensureDir, uid, month } from './util';
import { backupName, backupsNewestFirst, backupsToDrop, stateText } from '../shared/backup';
import { SEARCH_MIN, searchItems, type TextHit } from '../shared/textSearch';
import { paths } from './paths';
import { addSpend, type SessionSpend, type Spend } from '../shared/spend';
import { PAGE, itemsBefore, pageBefore } from '../shared/paging';
import { stampQueued } from '../shared/queue';
import type { Memo, Automation, ShellScript } from '../shared/types';
import type { AutoAnswer, ChatItem, ChatKind, Decision, LogPage, MemorySuggestion, Repo, Task, Worker, WorkerLogItem } from '../shared/types';

export interface DispatcherState {
  sessionId: string | null; date: string | null; contextTokens: number; accountId: string | null;
  /** Whose agent `sessionId` belongs to. Unset in older state files: Claude. */
  provider?: 'claude' | 'chatgpt';
  /** The Dispatcher's own spend (its sessions, the answer-on-your-behalf check and the memory-suggestion check) by month, YYYY-MM. */
  spend?: Record<string, Spend>;
  sessionSpend?: SessionSpend | null;
}

export interface Data {
  version: 1;
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
  /** Paths the user attached to messages (see attachments.ts) */
  attachments?: string[];
}

const empty = (): Data => ({
  version: 1,
  counters: { worker: 0, task: 0 },
  repos: [], workers: [], tasks: [], decisions: [], autoAnswers: [], memorySuggestions: [], chat: [],
  dispatcher: { sessionId: null, date: null, contextTokens: 0, accountId: null },
  pendingUpdates: [],
});

class Store extends EventEmitter {
  data: Data = empty();

  /** Set by load() when the state file could not be read and a backup took its place: the day of that backup, or 'none'. */
  restoredFrom: string | null = null;

  /**
   * Reads the state. A file that holds something unreadable is set aside (never overwritten), and the newest
   * backup that can be read takes its place; with none, the app starts empty and says so.
   */
  load() {
    const file = paths().state;
    let text: string | null = null;
    try { text = fs.readFileSync(file, 'utf8'); } catch { /* a first run */ }
    if (stateText(text) === 'broken') {
      const aside = path.join(paths().data, `state-broken-${Date.now()}.json`);
      try { fs.copyFileSync(file, aside); } catch { /* kept where it is */ }
      this.restoredFrom = 'none';
      text = null;
      let names: string[] = [];
      try { names = fs.readdirSync(paths().backups); } catch { /* no backups yet */ }
      for (const name of backupsNewestFirst(names)) {
        let candidate: string | null = null;
        try { candidate = fs.readFileSync(path.join(paths().backups, name), 'utf8'); } catch { continue; }
        if (stateText(candidate) !== 'ok') continue;
        text = candidate;
        this.restoredFrom = name.replace(/^state-|\.json$/g, '');
        break;
      }
    }
    const raw = stateText(text) === 'ok' ? (JSON.parse(text!.replace(/^\uFEFF/, '')) as Partial<Data>) : {};
    this.data = { ...empty(), ...raw } as Data;
    if (this.restoredFrom) this.flush();
  }

  /**
   * Once a day, the state as it is on disk is copied to data/backups, and the oldest copies beyond a week go.
   * Called at launch and every hour; a day that already has its copy is left alone.
   */
  backup(now = new Date()) {
    try {
      const dir = paths().backups;
      ensureDir(dir);
      const target = path.join(dir, backupName(now));
      if (fs.existsSync(target)) return;
      let text: string | null = null;
      try { text = fs.readFileSync(paths().state, 'utf8'); } catch { return; }
      if (stateText(text) !== 'ok') return; // never keep a copy of a file that cannot be read
      fs.writeFileSync(target, text);
      for (const old of backupsToDrop(fs.readdirSync(dir))) fs.rmSync(path.join(dir, old), { force: true });
    } catch { /* a backup that fails must not stop the app */ }
  }

  private persist = debounce(() => writeJsonAtomic(paths().state, this.data), 300);

  changed() {
    stampQueued(this.data.tasks);
    this.persist();
    this.emit('changed');
  }

  flush() {
    writeJsonAtomic(paths().state, this.data);
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

  chat(kind: ChatKind, text: string, ref?: string, replyTo?: string | null) {
    const item: ChatItem = { id: uid(), ts: nowIso(), kind, text, ref };
    if (replyTo) item.replyTo = replyTo;
    this.data.chat.push(item);
    if (this.data.chat.length > 2000) this.data.chat.splice(0, this.data.chat.length - 2000);
    this.changed();
    return item;
  }

  /** A Worker made or a task handed out (`ref`: the task): the chat folds these into one block (shared/handouts.ts). */
  handout(text: string, ref?: string) {
    const item = this.chat('event', text, ref);
    item.sub = 'handout';
    return item;
  }

  log(workerId: string, from: WorkerLogItem['from'], text: string) {
    const item: WorkerLogItem = { ts: nowIso(), from, text };
    ensureDir(paths().workerLogs);
    fs.appendFileSync(path.join(paths().workerLogs, `${workerId}.jsonl`), JSON.stringify(item) + '\n', 'utf8');
    this.emit('workerLog', workerId, item);
  }

  /** A page of a Worker's log: the last `limit` lines before line `before` (the end when absent). Lines that don't parse are skipped. */
  readLog(workerId: string, before?: number, limit: number = PAGE.log): LogPage {
    let lines: string[];
    try {
      lines = fs.readFileSync(path.join(paths().workerLogs, `${workerId}.jsonl`), 'utf8').split('\n').filter(Boolean);
    } catch {
      return { items: [], start: 0, total: 0 };
    }
    const { start, end } = pageBefore(lines.length, before, limit);
    const items: WorkerLogItem[] = [];
    for (const l of lines.slice(start, end)) {
      try { items.push(JSON.parse(l) as WorkerLogItem); } catch { /* a torn line */ }
    }
    return { items, start, total: lines.length };
  }

  /** Up to `limit` chat items right before the one with id `before`, and whether there are more. */
  /**
   * What was said that matches a query: the chat with the Dispatcher (what the user and it said) and each Worker's
   * conversation, newest first. Workers that are not archived are read first; a Worker gives a few lines at most.
   */
  searchText(query: string, limit = 24): TextHit[] {
    if (query.trim().length < SEARCH_MIN) return [];
    const said = this.data.chat.filter((c) => c.kind === 'user' || c.kind === 'dispatcher');
    const out = searchItems(said, query, Math.ceil(limit / 2), (c) => c.id, 'chat');
    const workers = [...this.data.workers].sort((a, b) => Number(a.status === 'archived') - Number(b.status === 'archived') || b.lastActiveAt.localeCompare(a.lastActiveAt));
    for (const w of workers) {
      if (out.length >= limit) break;
      let items: WorkerLogItem[] = [];
      try {
        items = fs.readFileSync(path.join(paths().workerLogs, `${w.id}.jsonl`), 'utf8').split('\n').filter(Boolean)
          .map((l) => { try { return JSON.parse(l) as WorkerLogItem; } catch { return { ts: '', from: 'event' as const, text: '' }; } });
      } catch { continue; }
      // Events ("ran a tool") are not something said; the line number stays the log's own.
      const lines = items.map((x) => (x.from === 'event' ? { ...x, text: '' } : x));
      out.push(...searchItems(lines, query, Math.min(4, limit - out.length), (_x, i) => String(i), w.id));
    }
    return out.slice(0, limit);
  }

  chatPage(before: string, limit: number = PAGE.chat) {
    return itemsBefore(this.data.chat, before, limit);
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
