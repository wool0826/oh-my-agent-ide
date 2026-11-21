import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workerDecisions } from '../src/shared/inbox';
import type { Decision } from '../src/shared/types';

function dec(id: string, patch: Partial<Decision> = {}): Decision {
  return {
    id, source: 'question', workerId: 'W-01', taskId: null, title: 'Which one?', detail: '', code: null, options: [],
    questionKey: null, status: 'pending', answer: null, createdAt: '', answeredAt: null, ...patch,
  };
}

test('inbox: a Worker\'s open decisions are its pending questions, permissions and plans, oldest first', () => {
  const all = [
    dec('a', { source: 'permission' }),
    dec('b', { workerId: 'W-02' }),
    dec('c', { status: 'answered', answer: 'x' }),
    dec('d', { source: 'dispatcher', workerId: 'W-01' }),
    dec('e', { source: 'plan' }),
    dec('f'),
  ];
  assert.deepEqual(workerDecisions(all, 'W-01').map((d) => d.id), ['a', 'e', 'f']);
  assert.deepEqual(workerDecisions(all, null), []);
  assert.deepEqual(workerDecisions([dec('g', { workerId: null, source: 'dispatcher' })], undefined), []);
});
