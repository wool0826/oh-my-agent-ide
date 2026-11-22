import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { answer, ask, waitFor } from '../src/main/decisions';
import { store } from '../src/main/store';
import type { Decision } from '../src/shared/types';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-decisions-'));
process.env.OMA_DATA_DIR = tmp;
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ home: path.join(tmp, 'home'), language: 'en', accounts: [] }));

const card: Omit<Decision, 'id' | 'status' | 'answer' | 'createdAt' | 'answeredAt'> = {
  source: 'question', workerId: 'W-1', taskId: 'T-1', title: 'Which one?', detail: '', code: null, options: [{ label: 'A' }, { label: 'B' }], questionKey: null,
};
const pending = () => store.data.decisions.filter((d) => d.status === 'pending');

test('a question whose signal aborted already is never shown, so nobody is left to answer it (L5)', async () => {
  store.data.decisions = [];
  const c = new AbortController();
  c.abort();
  await assert.rejects(ask(card, c.signal), /aborted/);
  assert.equal(pending().length, 0);
});

test('aborting withdraws the card; an answer resolves the asker', async () => {
  store.data.decisions = [];
  const c = new AbortController();
  const p = ask(card, c.signal);
  assert.equal(pending().length, 1);
  c.abort();
  await assert.rejects(p, /aborted/);
  assert.equal(pending().length, 0);
  const q = ask(card);
  answer(pending()[0].id, 'B');
  assert.equal(await q, 'B');
});

test('waitFor waits again for a card kept over a restart (L5)', async () => {
  store.data.decisions = [];
  const kept: Decision = { ...card, id: 'kept', status: 'pending', answer: null, createdAt: '', answeredAt: null };
  store.data.decisions.push(kept);
  const p = waitFor('kept');
  answer('kept', 'A');
  assert.equal(await p, 'A');
});
