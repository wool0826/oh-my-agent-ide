import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseAccount, type RoutableAccount } from '../src/shared/usage';
import { modelLabel, providerOf } from '../src/shared/models';

const acc = (id: string, used: number, extra: Partial<RoutableAccount> = {}): RoutableAccount => ({
  id, fiveHour: { utilization: used, resetsAt: null }, sevenDay: { utilization: null, resetsAt: null }, limitedUntil: null, lastAssignedAt: null, ...extra,
});

test('a model runs on the agent of its provider: Claude Code for Claude models, Codex for the rest', () => {
  assert.equal(providerOf('claude-opus-5-5'), 'claude');
  assert.equal(providerOf('gpt-6-luna'), 'chatgpt');
  assert.equal(providerOf('gpt-5.6-terra'), 'chatgpt');
  // The list knows better than the name.
  assert.equal(providerOf('house-model', [{ id: 'house-model', name: 'House', created: '', provider: 'claude' }]), 'claude');
});

test('a ChatGPT model is shown by the name Codex gives it', () => {
  const models = [{ id: 'gpt-6-luna', name: 'GPT-6-Luna', created: '', provider: 'chatgpt' as const }];
  assert.equal(modelLabel('gpt-6-luna', models), 'GPT-6-Luna');
  assert.equal(modelLabel('gpt-6-luna'), 'gpt-6-luna');
});

test('a session is given an account of its own provider, however free the others are', () => {
  const list = [acc('claude-busy', 90), acc('gpt', 0, { provider: 'chatgpt' }), acc('claude-old', 60)];
  assert.equal(chooseAccount(list, Date.now(), null, 'claude')?.id, 'claude-old');
  assert.equal(chooseAccount(list, Date.now(), null, 'chatgpt')?.id, 'gpt');
  // An account saved before providers existed is a Claude account.
  assert.equal(chooseAccount([acc('legacy', 10)], Date.now(), null, 'chatgpt'), null);
  assert.equal(chooseAccount([acc('legacy', 10)], Date.now(), null, 'claude')?.id, 'legacy');
});

test('with its only account held by a limit, a provider has none to give', () => {
  const later = new Date(Date.now() + 3600_000).toISOString();
  const list = [acc('claude', 10), acc('gpt', 100, { provider: 'chatgpt', limitedUntil: later })];
  assert.equal(chooseAccount(list, Date.now(), null, 'chatgpt'), null);
  assert.equal(chooseAccount(list, Date.now(), null, 'claude')?.id, 'claude');
});

test('without a provider the choice is among all accounts, as before', () => {
  assert.equal(chooseAccount([acc('a', 50), acc('b', 5, { provider: 'chatgpt' })])?.id, 'b');
});
