import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { settle } from '../src/main/prmonitor';
import { store } from '../src/main/store';
import { prsToWatch } from '../src/shared/prs';
import type { Task, Worker } from '../src/shared/types';

// Settings and the IDE home live in a temp folder. Tasks have no repository, so no git command runs.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-prmonitor-'));
process.env.OMA_DATA_DIR = tmp;
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ home: path.join(tmp, 'home'), language: 'en', notifications: false, accounts: [] }));

const now = new Date().toISOString();
let n = 0;

function addTask(over: Partial<Task>): Task {
  const x: Task = {
    id: `T-${++n}`, title: `Task ${n}`, prompt: '', kind: 'code', repo: null, workerId: 'W-21', status: 'pr_open',
    branch: `agent/t-${n}`, prUrl: null, prState: null, summary: null, files: [], createdAt: now, updatedAt: now, startedAt: now,
    finishedAt: now, reviewSyncedAt: null, seenCommentIds: [], ...over,
  };
  store.data.tasks.push(x);
  return x;
}

function onPr(url: string) {
  const w = prsToWatch(store.data.tasks).find((x) => x.url === url);
  assert.ok(w, url);
  return w;
}

store.data.workers.push({
  id: 'W-21', title: 'Worker', model: 'claude-opus-5-5', accountId: null, sessionId: null, cwd: tmp, repo: null,
  status: 'idle', statusText: '', contextTokens: 0, taskIds: [], createdAt: now, lastActiveAt: now, knowledge: '',
} satisfies Worker);

test('prmonitor: a merged PR two tasks recorded is announced once and settles both', async () => {
  const url = 'https://github.com/o/r/pull/17';
  const opened = addTask({ title: 'B3: Worker cap', prUrl: url, prState: 'OPEN' });
  const followup = addTask({ title: 'Resolve PR #17 conflicts', prUrl: url, prState: 'OPEN' });
  const failed = addTask({ title: 'Later fix that failed', prUrl: url, prState: 'OPEN', status: 'failed' });
  const chat = store.data.chat.length;
  const updates = store.data.pendingUpdates.length;

  await settle(onPr(url), 'MERGED', 'agent/t-1');

  const events = store.data.chat.slice(chat);
  assert.deepEqual(events.map((c) => c.text), ['B3: Worker cap: PR merged, branch cleaned up']);
  assert.equal(store.data.pendingUpdates.length - updates, 1);
  assert.match(store.data.pendingUpdates.at(-1)!, new RegExp(`${opened.id} "B3: Worker cap" PR merged \\(also recorded by ${followup.id}\\)`));
  for (const x of [opened, followup]) {
    assert.equal(x.status, 'done', x.id);
    assert.equal(x.prState, 'MERGED', x.id);
    assert.ok(x.mergedAt, x.id);
  }
  // A task that recorded the PR but was not in review keeps its status and learns the PR merged.
  assert.equal(failed.status, 'failed');
  assert.equal(failed.prState, 'MERGED');
  assert.deepEqual(prsToWatch(store.data.tasks).filter((x) => x.url === url), []);
});

test('prmonitor: a follow-up still open on a PR already announced settles quietly', async () => {
  const url = 'https://github.com/o/r/pull/18';
  addTask({ prUrl: url, prState: 'MERGED', status: 'done' });
  const followup = addTask({ prUrl: url, prState: 'OPEN' });
  const chat = store.data.chat.length;

  await settle(onPr(url), 'MERGED', 'agent/t-x');

  assert.equal(store.data.chat.length, chat);
  assert.equal(followup.status, 'done');
  assert.equal(followup.prState, 'MERGED');
});

test('prmonitor: tasks waiting for the follow-up are released when the shared PR closes', async () => {
  const url = 'https://github.com/o/r/pull/19';
  addTask({ prUrl: url, prState: 'OPEN' });
  const followup = addTask({ prUrl: url, prState: 'OPEN' });
  const waiting = addTask({ status: 'blocked', afterTaskId: followup.id, finishedAt: null, startedAt: null });

  await settle(onPr(url), 'CLOSED', 'agent/t-x');

  assert.equal(waiting.status, 'cancelled');
  assert.equal(followup.prState, 'CLOSED');
  assert.equal(store.data.chat.filter((c) => c.text.includes('PR closed without merging')).length, 1);
});
