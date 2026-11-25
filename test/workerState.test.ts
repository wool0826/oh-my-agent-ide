import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tr } from '../src/shared/i18n';
import type { Say } from '../src/shared/askWhy';
import { askLine, lastFailed, plainStatus, stateCounts, stepText, workerLine, workerState } from '../src/shared/workerState';
import type { Task, TaskStep, Worker } from '../src/shared/types';

const en: Say = (k, v) => tr('en', k, v);
type W = Pick<Worker, 'status' | 'statusText' | 'request' | 'stalledAt'>;
type T = Pick<Task, 'status' | 'stopped' | 'summary' | 'steps'>;
const w = (status: Worker['status'], extra: Partial<W> = {}): W => ({ status, statusText: '', request: null, ...extra });
const x = (status: Task['status'], extra: Partial<T> = {}): T => ({ status, stopped: false, summary: null, steps: null, ...extra });
const plan = (done: number, titles = ['Read the code', 'Write tests', 'Open the PR']): TaskStep[] =>
  titles.map((title, i) => ({ title, doneAt: i < done ? '2026-11-22T12:00:00Z' : null }));

test('a failed turn leaves the Worker idle, so its last task says it stopped with an error', () => {
  assert.equal(lastFailed(w('idle'), x('failed')), true);
  assert.equal(workerState(w('idle'), x('failed')), 'failed');
  // A lost session sets the status itself, whatever the task says.
  assert.equal(workerState(w('error'), x('running')), 'failed');
  assert.equal(workerState(w('error'), null), 'failed');
});

test('a task the user stopped is stopped, not failed', () => {
  assert.equal(lastFailed(w('idle'), x('failed', { stopped: true })), false);
  assert.equal(workerState(w('idle'), x('failed', { stopped: true })), 'stopped');
});

test('the failure mark clears once the Worker goes on or gets another task', () => {
  assert.equal(workerState(w('running'), x('failed')), 'run');
  assert.equal(workerState(w('starting'), x('failed')), 'run');
  assert.equal(workerState(w('idle'), x('queued')), 'queued');
  assert.equal(workerState(w('idle'), x('done')), 'done');
});

test('each state of a Worker has its own name', () => {
  assert.equal(workerState(w('archived'), x('failed')), 'archived');
  assert.equal(workerState(w('waiting'), x('waiting')), 'ask');
  assert.equal(workerState(w('idle', { request: { text: 'Which branch?', at: '' } }), x('waiting')), 'asked');
  assert.equal(workerState(w('idle'), x('blocked')), 'queued');
  assert.equal(workerState(w('idle'), x('pr_open')), 'pr');
  assert.equal(workerState(w('idle'), x('cancelled')), 'idle');
  assert.equal(workerState(w('idle'), null), 'idle');
});

test('plainStatus drops the report protocol and keeps what was said', () => {
  assert.equal(plainStatus('RESULT: Added the export PR: https://github.com/o/r/pull/7'), 'Added the export');
  assert.equal(plainStatus('PR: https://github.com/o/r/pull/7 RESULT: Added the export FILE: C:\\out\\a.md'), 'Added the export');
  assert.equal(plainStatus('BLOCKED: needs the API key'), 'needs the API key');
  assert.equal(plainStatus('PR: https://github.com/o/r/pull/7'), '');
  // Text that is no report is kept, on one line.
  assert.equal(plainStatus('Reading  src/cart.ts\nnow'), 'Reading src/cart.ts now');
  assert.equal(plainStatus('The RESULT: line is missing'), 'The RESULT: line is missing');
  assert.equal(plainStatus(null), '');
});

test('a running Worker shows the step it is on, or what it is doing', () => {
  const line = workerLine(en, w('running', { statusText: '$ npm test' }), x('running', { steps: plan(1) }), {});
  assert.equal(line.text, '2/3 · Write tests');
  assert.equal(line.steps?.at, 1);
  assert.equal(workerLine(en, w('running', { statusText: '$ npm test' }), x('running'), {}).text, '$ npm test');
  // Every step done: the plan has no news, so its last words do.
  assert.equal(workerLine(en, w('running', { statusText: 'RESULT: All green' }), x('running', { steps: plan(3) }), {}).text, 'All green');
  assert.equal(workerLine(en, w('running'), x('running'), {}).text, 'Running');
});

test('a failed Worker says where it stopped and why', () => {
  const line = workerLine(en, w('idle'), x('failed', { summary: 'npm test exited with 1', steps: plan(1) }), {});
  assert.equal(line.text, 'Stopped at 2/3 · Write tests · npm test exited with 1');
  assert.equal(line.steps?.at, 1);
  // Without a plan, the error alone; without either, the state's name.
  assert.deepEqual(workerLine(en, w('idle'), x('failed', { summary: 'Out of memory' }), {}), { text: 'Out of memory', steps: null });
  assert.equal(workerLine(en, w('idle'), x('failed'), {}).text, 'Failed');
  // A lost session carries its own error text.
  assert.equal(workerLine(en, w('error', { statusText: 'Session lost' }), x('running'), {}).text, 'Session lost');
});

test('a waiting or queued Worker shows what it waits for', () => {
  assert.equal(workerLine(en, w('waiting'), x('waiting'), { ask: 'Run npm install?' }).text, 'Run npm install?');
  assert.equal(workerLine(en, w('waiting'), x('waiting'), {}).text, 'Needs your decision');
  assert.equal(workerLine(en, w('idle', { request: { text: 'Which branch do I base this on?', at: '' } }), x('waiting'), {}).text, 'Which branch do I base this on?');
  assert.deepEqual(workerLine(en, w('idle'), x('queued', { steps: plan(1) }), { queue: '2nd in line' }), { text: '2nd in line', steps: null });
});

test('a finished Worker shows its one-line result, and one with no news what it is', () => {
  const about = 'demo, Fable';
  assert.equal(workerLine(en, w('idle'), x('pr_open', { summary: 'RESULT: Added CSV export PR: https://github.com/o/r/pull/7' }), { about }).text, 'Added CSV export');
  assert.equal(workerLine(en, w('idle'), x('done'), { about }).text, about);
  assert.equal(workerLine(en, w('idle'), null, { about }).text, about);
  assert.equal(workerLine(en, w('archived'), x('done', { summary: 'Done long ago' }), { about }).text, about);
});

test('the heading counts states: done includes open PRs, and a Worker waiting for the Dispatcher is not queued', () => {
  assert.deepEqual(stateCounts(['ask', 'ask', 'run', 'failed', 'queued', 'asked', 'pr', 'done', 'idle', 'stopped']), { ask: 2, run: 1, failed: 1, stalled: 0, queued: 1, done: 2 });
  assert.deepEqual(stateCounts([]), { ask: 0, run: 0, failed: 0, stalled: 0, queued: 0, done: 0 });
});

test('askLine: a command is named with the command, a plan with what it is for, a question as asked', () => {
  assert.equal(askLine({ source: 'permission', title: 'Run this command?', code: 'npm install\n  csv-stringify', summary: null }), 'Run this command? npm install csv-stringify');
  assert.equal(askLine({ source: 'permission', title: 'Allow these files?', code: null, summary: null }), 'Allow these files?');
  assert.equal(askLine({ source: 'question', title: 'Split the PR?', code: 'ignored', summary: null }), 'Split the PR?');
  assert.equal(askLine({ source: 'plan', title: 'Review the plan', code: null, summary: { what: 'Rename the field', how: 'One commit', output: 'A PR' } as never }), 'Rename the field');
});

test('a Worker flagged as stalled says so while it sits idle on its open task, with the step it is on', () => {
  const stalled = w('idle', { stalledAt: '2026-11-22T12:00:00Z', statusText: 'Waiting for the subagent' });
  assert.equal(workerState(stalled, x('running')), 'stalled');
  assert.equal(workerLine(en, stalled, x('running', { steps: plan(1) }), {}).text, '2/3 · Write tests');
  assert.equal(workerLine(en, stalled, x('running'), {}).text, 'Waiting for the subagent');
  // Once it runs again the flag no longer shows.
  assert.equal(workerState(w('running', { stalledAt: '2026-11-22T12:00:00Z' }), x('running')), 'run');
  assert.equal(stateCounts(['stalled', 'run']).stalled, 1);
});

test('every screen writes a plan the same way: the step on, where it stopped, or all done', () => {
  const ko: Say = (k, v) => tr('ko', k, v);
  const v = { done: 1, total: 3, at: 1, current: 'Review', allDone: false };
  assert.equal(stepText(en, v), '2/3 · Review');
  assert.equal(stepText(en, v, true), 'Stopped at 2/3 · Review');
  assert.equal(stepText(ko, v, true), '2/3 Review에서 멈춤');
  assert.equal(stepText(en, { ...v, done: 3, at: 3, allDone: true }), 'All 3 steps done');
});
