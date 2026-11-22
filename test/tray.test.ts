import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeAction, trayCounts, trayLines } from '../src/shared/tray';
import type { Task } from '../src/shared/types';

const task = (status: Task['status']): Task => ({
  id: 'T', title: 't', prompt: '', kind: 'code', repo: 'r', workerId: 'W', status, branch: null, prUrl: null, prState: null, summary: null, files: [],
  createdAt: '', updatedAt: '', finishedAt: null, reviewSyncedAt: null, seenCommentIds: [],
});

test('closing the window hides it only when the app keeps running and is not quitting', () => {
  assert.equal(closeAction({ quitting: false, background: true }), 'hide');
  assert.equal(closeAction({ quitting: true, background: true }), 'close');
  assert.equal(closeAction({ quitting: false, background: false }), 'close');
});

test('the tray counts waiting decisions, Workers at work and queued tasks', () => {
  const c = trayCounts({
    decisions: [{ status: 'pending' }, { status: 'answered' }, { status: 'pending' }],
    workers: [{ status: 'running' }, { status: 'starting' }, { status: 'idle' }, { status: 'waiting' }],
    tasks: [task('queued'), task('running'), task('done')],
  });
  assert.deepEqual(c, { decisions: 2, running: 2, queued: 1 });
});

test('the tray lists what is going on, decisions first, or says nothing is', () => {
  assert.deepEqual(trayLines({ decisions: 1, running: 2, queued: 0 }), ['decisions', 'running']);
  assert.deepEqual(trayLines({ decisions: 0, running: 0, queued: 3 }), ['queued']);
  assert.deepEqual(trayLines({ decisions: 0, running: 0, queued: 0 }), ['none']);
});
