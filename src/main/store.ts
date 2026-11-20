import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { readJson, writeJsonAtomic, debounce, nowIso, ensureDir, uid } from './util';
import { paths } from './paths';
import type { AutoAnswer, ChatItem, ChatKind, Decision, Repo, Task, Worker, WorkerLogItem } from '../shared/types';

export interface DispatcherState { sessionId: string | null; date: string | null; contextTokens: number; accountId: string | null }

export interface Data {
  version: 1;
  counters: { worker: number; task: number };
  repos: Repo[];
  workers: Worker[];
  tasks: Task[];
  decisions: Decision[];
  autoAnswers: AutoAnswer[];
  chat: ChatItem[];
  dispatcher: DispatcherState;
  /** Dispatcher가 다음 턴에 알아야 할 Worker 소식 */
  pendingUpdates: string[];
}

const empty = (): Data => ({
  version: 1,
  counters: { worker: 0, task: 0 },
  repos: [], workers: [], tasks: [], decisions: [], autoAnswers: [], chat: [],
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

  readLog(workerId: string): WorkerLogItem[] {
    try {
      return fs.readFileSync(path.join(paths().workerLogs, `${workerId}.jsonl`), 'utf8')
        .split('\n').filter(Boolean).map((l) => JSON.parse(l) as WorkerLogItem);
    } catch {
      return [];
    }
  }

  pushUpdate(text: string) {
    this.data.pendingUpdates.push(text);
    if (this.data.pendingUpdates.length > 50) this.data.pendingUpdates.splice(0, this.data.pendingUpdates.length - 50);
    this.changed();
  }

  takeUpdates(): string[] {
    const u = this.data.pendingUpdates.splice(0);
    if (u.length) this.changed();
    return u;
  }
}

export const store = new Store();
