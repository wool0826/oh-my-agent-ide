import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isStalled, shownStalled, STALL_MS } from '../src/shared/stall';
import type { Task, Worker } from '../src/shared/types';

const at = Date.parse('2026-11-22T12:00:00Z');
const later = at + STALL_MS;
const w = (over: Partial<Worker> = {}) => ({ id: 'W-1', status: 'idle', lastActiveAt: new Date(at).toISOString(), ...over }) as Worker;
const task = (over: Partial<Task> = {}) => ({ id: 'T-1', status: 'running', ...over }) as Task;
const idle = { busy: false, background: 0 };

test('an open task whose Worker sat idle for the stall time, with nothing running, is stalled', () => {
  assert.equal(isStalled(w(), task(), idle, later), true);
  assert.equal(isStalled(w(), task(), null, later), true);
  assert.equal(isStalled(w(), task(), idle, later - 1), false);
});

test('busy sessions, running subagents and tasks that wait for someone are not stalled', () => {
  assert.equal(isStalled(w(), task(), { busy: true, background: 0 }, later), false);
  assert.equal(isStalled(w(), task(), { busy: false, background: 2 }, later), false);
  assert.equal(isStalled(w({ status: 'running' }), task(), idle, later), false);
  assert.equal(isStalled(w(), task({ status: 'waiting' }), idle, later), false);
  assert.equal(isStalled(w(), task({ status: 'queued' }), idle, later), false);
  assert.equal(isStalled(w(), null, idle, later), false);
  assert.equal(isStalled(w(), task({ planFirst: true }), idle, later), false);
  assert.equal(isStalled(w(), task({ planFirst: true, planApproved: true }), idle, later), true);
  assert.equal(isStalled(w({ request: { text: 'Which repo?', at: '' } }), task(), idle, later), false);
});

test('the stalled flag shows only while the Worker is still idle', () => {
  assert.equal(shownStalled(w({ stalledAt: 'x' })), true);
  assert.equal(shownStalled(w({ stalledAt: 'x', status: 'running' })), false);
  assert.equal(shownStalled(w()), false);
});
