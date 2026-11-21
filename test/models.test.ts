import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelLabel, sortModels } from '../src/shared/models';

test('models: the API display name wins, without "Claude"', () => {
  assert.equal(modelLabel('claude-opus-5-5', [{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5', created: '' }]), 'Opus 5.5');
});

test('models: names read from ids in both id styles', () => {
  assert.equal(modelLabel('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(modelLabel('claude-sonnet-4-20250514'), 'Sonnet 4');
  assert.equal(modelLabel('claude-opus-4-1-20250805'), 'Opus 4.1');
  assert.equal(modelLabel('claude-3-5-haiku-20241022'), 'Haiku 3.5');
  assert.equal(modelLabel('claude-3-haiku-20240307'), 'Haiku 3');
  assert.equal(modelLabel('some-gateway-model'), 'some-gateway-model');
});

test('models: newest first', () => {
  const list = sortModels([
    { id: 'a', name: 'A', created: '2025-05-14T00:00:00Z' },
    { id: 'b', name: 'B', created: '2026-09-01T00:00:00Z' },
    { id: 'c', name: 'C', created: '2024-03-07T00:00:00Z' },
  ]);
  assert.deepEqual(list.map((m) => m.id), ['b', 'a', 'c']);
});
