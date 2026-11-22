import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canPick, compareModels, openComparisons } from '../src/shared/compare';
import type { Task } from '../src/shared/types';

const models = [
  { id: 'claude-opus-5-5', provider: 'claude' as const }, { id: 'claude-fable-5-2', provider: 'claude' as const },
  { id: 'gpt-6-luna', provider: 'chatgpt' as const },
];
const task = (id: string, status: Task['status'], compare?: Task['compare']): Task => ({
  id, title: 't', prompt: '', kind: 'code', repo: 'r', workerId: 'W', status, branch: null, prUrl: null, prState: null, summary: null, files: [],
  createdAt: '', updatedAt: '', finishedAt: null, reviewSyncedAt: null, seenCommentIds: [], compare,
});

test('the second model is from the other provider when it has an account', () => {
  assert.deepEqual(compareModels('claude-opus-5-5', 'claude-fable-5-2', models, ['claude', 'chatgpt']), ['claude-opus-5-5', 'gpt-6-luna']);
  assert.deepEqual(compareModels('gpt-6-luna', 'claude-fable-5-2', models, ['claude', 'chatgpt']), ['gpt-6-luna', 'claude-opus-5-5']);
});

test('with one provider it is the design model, then any other model, then nothing', () => {
  assert.deepEqual(compareModels('claude-opus-5-5', 'claude-fable-5-2', models, ['claude']), ['claude-opus-5-5', 'claude-fable-5-2']);
  assert.deepEqual(compareModels('claude-opus-5-5', 'claude-opus-5-5', models, ['claude']), ['claude-opus-5-5', 'claude-fable-5-2']);
  assert.equal(compareModels('claude-opus-5-5', 'claude-opus-5-5', [models[0]], ['claude']), null);
});

test('a comparison stays open until one attempt is picked', () => {
  const tasks = [
    task('T-1', 'done', { group: 'g1' }), task('T-2', 'running', { group: 'g1' }),
    task('T-3', 'done', { group: 'g2', picked: 'T-3' }), task('T-4', 'done', { group: 'g2', picked: 'T-3' }),
    task('T-5', 'done'),
  ];
  const open = openComparisons(tasks);
  assert.deepEqual(open.map((g) => [g.group, g.tasks.map((x) => x.id), g.settled]), [['g1', ['T-1', 'T-2'], false]]);
  tasks[1].status = 'failed';
  assert.equal(openComparisons(tasks)[0].settled, true);
});

test('only a finished attempt can be picked', () => {
  assert.equal(canPick({ status: 'done' }), true);
  for (const st of ['running', 'queued', 'failed', 'cancelled', 'waiting'] as const) assert.equal(canPick({ status: st }), false);
});
