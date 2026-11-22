import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { readJson, writeJsonAtomic, debounce, nowIso, ensureDir, uid, month } from './util';
import { paths } from './paths';
import { addSpend, type SessionSpend, type Spend } from '../shared/spend';
import { PAGE, itemsBefore, pageBefore } from '../shared/paging';
import type { Memo } from '../shared/types';
import type { AutoAnswer, ChatItem, ChatKind, Decision, LogPage, MemorySuggestion, Repo, Task, Worker, WorkerLogItem } from '../shared/types';

export interface DispatcherState {
  sessionId: string | null; date: string | null; contextTokens: number; accountId: string | null;
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

  load() {
    const raw = readJson<Partial<Data>>(paths().state, {});
    this.data = { ...empty(), ...raw } as Data;
  }

  private persist = debounce(() => writeJsonAtomic(paths().state, this.data), 300);

  changed() {
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

  chat(kind: ChatKind, text: string, ref?: string) {
    const item: ChatItem = { id: uid(), ts: nowIso(), kind, text, ref };
    this.data.chat.push(item);
    if (this.data.chat.length > 2000) this.data.chat.splice(0, this.data.chat.length - 2000);
    this.changed();
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
  pushUpdate(text: string, wake = false) {
    this.data.pendingUpdates.push(text);
    if (this.data.pendingUpdates.length > 50) this.data.pendingUpdates.splice(0, this.data.pendingUpdates.length - 50);
    this.changed();
    if (wake) this.emit('wake');
  }

  takeUpdates(): string[] {
    const u = this.data.pendingUpdates.splice(0);
    if (u.length) this.changed();
    return u;
  }
}

export const store = new Store();
