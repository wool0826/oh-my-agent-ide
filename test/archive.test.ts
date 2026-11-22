import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { workers } from '../src/main/agents/workers';
import { AgentSession } from '../src/main/agents/session';
import { store } from '../src/main/store';
import { loadSettings } from '../src/main/settings';
import { ensureWorktree } from '../src/main/repos';
import { slotsUsed } from '../src/shared/slots';
import type { Repo, Task, Worker } from '../src/shared/types';

// Archiving Workers and removing repositories, with real git worktrees in a temp folder.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-archive-'));
process.env.OMA_DATA_DIR = tmp;
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({
  home: path.join(tmp, 'home'), language: 'en', claudeRules: false, claudeMemory: false, selfReview: false,
  accounts: [{ id: 'acc', label: 'Test', kind: 'login', plan: 'team' }],
}));

// No Claude Code process is started.
AgentSession.prototype.send = function () {
  this.busy = true;
  this.ev.onStatus?.('busy', '');
};
AgentSession.prototype.setMode = async function (mode) { this.cfg.permissionMode = mode; };

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' });

// An origin with one commit on main, and the app's clone of it.
const origin = path.join(tmp, 'origin.git');
const seed = path.join(tmp, 'seed');
fs.mkdirSync(seed);
git(seed, 'init', '-q', '-b', 'main');
fs.writeFileSync(path.join(seed, 'a.txt'), 'a\n');
git(seed, 'add', '.');
git(seed, 'commit', '-q', '-m', 'first');
git(tmp, 'clone', '-q', '--bare', seed, origin);
const main = path.join(tmp, 'main');
git(tmp, 'clone', '-q', origin, main);
const repo: Repo = { name: 'demo', url: origin, path: main, description: '', defaultBranch: 'main', addedAt: new Date().toISOString() };

const now = new Date().toISOString();
const old = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
let n = 0;

async function addWorker(over: Partial<Worker> = {}): Promise<Worker> {
  const id = `W-${++n}`;
  const cwd = await ensureWorktree(repo, id);
  const w: Worker = {
    id, title: 'Worker', model: 'claude-opus-5-5', accountId: null, sessionId: 'sid', cwd, repo: 'demo',
    status: 'idle', statusText: '', contextTokens: 0, taskIds: [], createdAt: now, lastActiveAt: now, knowledge: '', ...over,
  };
  store.data.workers.push(w);
  return w;
}

function addTask(w: Worker, over: Partial<Task> = {}): Task {
  const x: Task = {
    id: `T-${++n}`, title: 'Task', prompt: 'Do it.', kind: 'code', repo: 'demo', workerId: w.id, status: 'done',
    branch: null, prUrl: null, prState: null, summary: null, files: [], createdAt: now, updatedAt: now, startedAt: now,
    finishedAt: now, reviewSyncedAt: null, seenCommentIds: [], ...over,
  };
  store.data.tasks.push(x);
  w.taskIds.push(x.id);
  return x;
}

/** autoArchive starts archive() without waiting for it: run it and wait for what it started. */
async function autoArchive() {
  const started: Promise<unknown>[] = [];
  const own = workers.archive;
  workers.archive = (id: string) => { const p = own.call(workers, id); started.push(p); return p; };
  try { workers.autoArchive(); } finally { workers.archive = own; }
  await Promise.all(started);
}

beforeEach(() => {
  workers.closeAll();
  Object.assign(store.data, { workers: [], tasks: [], chat: [], pendingUpdates: [], decisions: [], repos: [repo] });
  loadSettings().maxWorkers = 3;
  loadSettings().archiveDays = 7;
});

test('archiving a Worker in the middle of a turn is refused: its task keeps its Worker and its folder stays (H2)', async () => {
  const w = await addWorker();
  const x = addTask(w, { status: 'running', finishedAt: null });
  workers.ensureSession(w)!.send('Working.');
  await assert.rejects(workers.archive(w.id), /is working on a task/);
  assert.equal(w.status, 'running');
  assert.equal(x.status, 'running');
  assert.ok(fs.existsSync(w.cwd));
  assert.equal(slotsUsed(store.data.tasks), 1);
});

test('a Worker whose task waits for an answer is not archived either (H2)', async () => {
  const w = await addWorker({ status: 'waiting' });
  addTask(w, { status: 'waiting', finishedAt: null });
  assert.throws(() => workers.checkArchive(w.id), /is working on a task/);
});

test('archiving keeps a worktree with uncommitted changes and removes a clean one (H2)', async () => {
  const dirty = await addWorker();
  addTask(dirty);
  fs.writeFileSync(path.join(dirty.cwd, 'a.txt'), 'changed\n');
  assert.deepEqual(await workers.archive(dirty.id), { kept: 'dirty' });
  assert.equal(dirty.status, 'archived');
  assert.ok(fs.existsSync(path.join(dirty.cwd, 'a.txt')));
  const clean = await addWorker();
  addTask(clean);
  assert.deepEqual(await workers.archive(clean.id), { kept: null });
  assert.ok(!fs.existsSync(clean.cwd));
});

test('auto-archive skips Workers with an open task, keeps uncommitted work, and never runs at 0 days (M4)', async () => {
  const idle = await addWorker({ lastActiveAt: old });
  addTask(idle);
  const asked = await addWorker({ lastActiveAt: old });
  addTask(asked, { status: 'waiting', finishedAt: null });
  const pr = await addWorker({ lastActiveAt: old });
  addTask(pr, { status: 'pr_open' });
  const dirty = await addWorker({ lastActiveAt: old });
  addTask(dirty, { status: 'failed' });
  fs.writeFileSync(path.join(dirty.cwd, 'b.txt'), 'new\n');
  loadSettings().archiveDays = 0;
  await autoArchive();
  assert.deepEqual(store.data.workers.map((w) => w.status), ['idle', 'idle', 'idle', 'idle']);
  loadSettings().archiveDays = 7;
  await autoArchive();
  assert.deepEqual(store.data.workers.map((w) => w.status), ['archived', 'idle', 'idle', 'archived']);
  assert.ok(!fs.existsSync(idle.cwd));
  assert.ok(fs.existsSync(path.join(dirty.cwd, 'b.txt')));
});

test('a task an older version left running on an archived Worker fails at restart instead of holding a slot (H2)', async () => {
  const w = await addWorker({ status: 'archived' });
  const x = addTask(w, { status: 'running', finishedAt: null });
  workers.resumeAfterRestart();
  assert.equal(x.status, 'failed');
  assert.equal(slotsUsed(store.data.tasks), 0);
});

test('removing a repository is refused while its tasks are open, then archives its Workers and their folders (M5)', async () => {
  const a = await addWorker();
  const x = addTask(a, { status: 'queued', finishedAt: null });
  await assert.rejects(workers.retireRepo('demo'), new RegExp(x.id));
  x.status = 'cancelled';
  // A worktree kept for an open PR goes too: nothing follows the PR once the repository is gone.
  const b = await addWorker({ status: 'archived' });
  addTask(b, { status: 'pr_open' });
  const c = await addWorker();
  addTask(c);
  fs.writeFileSync(path.join(c.cwd, 'c.txt'), 'keep me\n');
  assert.deepEqual(await workers.retireRepo('demo'), [c.id]);
  assert.deepEqual([a.status, b.status, c.status], ['archived', 'archived', 'archived']);
  assert.ok(!fs.existsSync(a.cwd) && !fs.existsSync(b.cwd));
  assert.ok(fs.existsSync(path.join(c.cwd, 'c.txt')));
});
