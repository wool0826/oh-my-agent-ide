import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticsText, redact, tailLines } from '../src/shared/diagnostics';

test('credentials are taken out, whatever shape they have', () => {
  const cases: [string, RegExp][] = [
    ['token sk-ant-oat01-abcdefghijklmnop in use', /sk-ant-\*\*\*/],
    ['GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123', /"\*\*\*"|ghp_\*\*\*/],
    ['Authorization: Bearer abc.def-ghi_jkl123', /\*\*\*/],
    ['authorization: Basic bWVAY29tcGFueS5jb206dG9r', /\*\*\*/],
    ['{"tokenEnc":"enc:AAAA////bbbb"}', /"tokenEnc":"\*\*\*"/],
    ['clone https://me:hunter2secret@github.company.com/x/y.git', /https:\/\/\*\*\*@github/],
    ['jira ATATT3xFfGF0abcdefghijklmnop=1234', /ATATT\*\*\*/],
  ];
  for (const [text, want] of cases) {
    const out = redact(text);
    assert.match(out, want, text);
    assert.doesNotMatch(out, /abcdefghijklmnop|hunter2secret|bWVAY29tcGFueS5jb206dG9r|AAAA\/\/\/\/bbbb|abc\.def-ghi_jkl123/, text);
  }
  assert.equal(redact('a plain line with a path C:\\Users\\me'), 'a plain line with a path C:\\Users\\me');
});

test('the report leaves out what identifies the company and keeps what explains a failure', () => {
  const text = diagnosticsText({
    app: { version: '0.5.0', platform: 'win32', arch: 'x64', electron: '45', node: '22', fake: false },
    settings: { language: 'ko', maxWorkers: 3, githubHost: 'github.company.com', jiraUrl: 'https://company.atlassian.net', jiraEmail: 'me@company.com', memoryRemote: '', jiraTokenSet: true },
    accounts: [{ label: 'Work main', kind: 'token', provider: 'claude', plan: 'team', limited: true, lastError: null }],
    checks: [{ id: 'git', ok: true, detail: 'git version 2.47' }, { id: 'ghAuth', host: 'github.company.com', ok: false, detail: 'not logged in' }],
    counts: { workers: { idle: 2 }, tasks: { done: 5, failed: 1 }, decisionsPending: 0, repos: 2, automations: 1 },
    log: '2026-11-22 INFO boot C:/Users/jdoe/oh-my-agent-ide\n2026-11-22 WARN pr view failed https://GitHub.Company.com/pay/api/pull/3\n2026-11-22 ERROR pr view failed with token ghp_abcdefghijklmnopqrstuvwxyz0123',
    now: '2026-11-22T10:00:00.000Z',
    hide: [{ text: 'github.company.com', as: '<company-github>' }, { text: 'jdoe', as: '<user>' }, { text: 'ab', as: '<short>' }],
  });
  assert.doesNotMatch(text, /company\.com|atlassian|me@|Work main|abcdefghijklmnop/);
  assert.match(text, /version: 0\.5\.0/);
  assert.match(text, /FAIL ghAuth \(company host\): not logged in/);
  assert.match(text, /1\. claude token team limited/);
  assert.match(text, /githubHost set: true/);
  assert.match(text, /memoryRemote set: false/);
  assert.match(text, /tasks: \{"done":5,"failed":1\}/);
  assert.match(text, /ERROR pr view failed/);
  // Words that name the user or the company are replaced wherever they are, the log included; a word too short to be one is not.
  assert.match(text, /boot C:\/Users\/<user>\/oh-my-agent-ide/);
  assert.match(text, /https:\/\/<company-github>\/pay\/api\/pull\/3/);
  assert.doesNotMatch(text, /jdoe|<short>/);
});

test('only the end of the log goes in', () => {
  assert.equal(tailLines('a\nb\nc\nd', 2), 'c\nd');
  assert.equal(tailLines('a', 5), 'a');
});
