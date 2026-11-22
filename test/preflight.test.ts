import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failedCount, failedFirst, fixCommand, preflightPlan } from '../src/shared/preflight';

test('the plan checks github.com, the company host when set, and Codex only when it is used', () => {
  assert.deepEqual(preflightPlan({ githubHost: '', models: ['claude-opus-5-5'], providers: ['claude'], fake: false }), { hosts: ['github.com'], codex: false, account: true });
  assert.deepEqual(preflightPlan({ githubHost: ' GitHub.Company.com ', models: ['claude-opus-5-5', 'gpt-6-luna'], providers: ['claude'], fake: false }).hosts, ['github.com', 'github.company.com']);
  assert.equal(preflightPlan({ githubHost: 'github.com', models: [], providers: ['chatgpt'], fake: false }).codex, true);
  assert.equal(preflightPlan({ githubHost: '', models: ['gpt-6-luna'], providers: [], fake: false }).codex, true);
});

test('fake agents need no account and no Codex', () => {
  assert.deepEqual(preflightPlan({ githubHost: '', models: ['gpt-6-luna'], providers: ['chatgpt'], fake: true }), { hosts: ['github.com'], codex: false, account: false });
});

test('a failed sign-in names the command that fixes it', () => {
  assert.equal(fixCommand({ id: 'ghAuth', host: 'github.company.com' }), 'gh auth login --hostname github.company.com');
  assert.equal(fixCommand({ id: 'codex' }), 'codex login');
  assert.equal(fixCommand({ id: 'git' }), null);
});

test('what failed is listed first', () => {
  const checks = [{ id: 'git' as const, ok: true, detail: '' }, { id: 'gh' as const, ok: false, detail: '' }, { id: 'home' as const, ok: true, detail: '' }];
  assert.deepEqual(failedFirst(checks).map((c) => c.id), ['gh', 'git', 'home']);
  assert.equal(failedCount(checks), 1);
});
