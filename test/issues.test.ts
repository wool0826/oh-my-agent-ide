import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ghRepoRef, issueMessage, parseIssues } from '../src/shared/issues';

test('a GitHub URL gives the host and owner/name, in https or ssh form', () => {
  assert.deepEqual(ghRepoRef('https://github.com/acme/billing.git'), { host: 'github.com', slug: 'acme/billing' });
  assert.deepEqual(ghRepoRef('https://github.company.com/pay/core/'), { host: 'github.company.com', slug: 'pay/core' });
  assert.deepEqual(ghRepoRef('git@github.com:acme/billing.git'), { host: 'github.com', slug: 'acme/billing' });
  assert.deepEqual(ghRepoRef('ssh://git@github.com/acme/billing'), { host: 'github.com', slug: 'acme/billing' });
});

test('a local folder is not a GitHub repository', () => {
  assert.equal(ghRepoRef('C:\\work\\billing'), null);
  assert.equal(ghRepoRef('/home/me/billing'), null);
  assert.equal(ghRepoRef(''), null);
});

test('issues are read from gh, and rows that are not issues are dropped', () => {
  const json = JSON.stringify([
    { number: 12, title: 'Tax is rounded twice', url: 'https://github.com/acme/billing/issues/12', labels: [{ name: 'bug' }, { name: 'p1' }], updatedAt: '2026-11-20T01:00:00Z' },
    { number: 'x', title: 'bad' },
    { number: 9, title: 'No labels', url: 'https://github.com/acme/billing/issues/9' },
  ]);
  assert.deepEqual(parseIssues(json), [
    { number: 12, title: 'Tax is rounded twice', url: 'https://github.com/acme/billing/issues/12', labels: ['bug', 'p1'], updatedAt: '2026-11-20T01:00:00Z' },
    { number: 9, title: 'No labels', url: 'https://github.com/acme/billing/issues/9', labels: [], updatedAt: '' },
  ]);
  assert.deepEqual(parseIssues('not json'), []);
  assert.deepEqual(parseIssues('{}'), []);
});

test('the message names the repository, the issue and its link', () => {
  const m = issueMessage('billing', { number: 12, title: 'Tax is rounded twice', url: 'https://github.com/acme/billing/issues/12' });
  assert.ok(m.startsWith('@billing Work on issue #12: Tax is rounded twice\nhttps://github.com/acme/billing/issues/12\n'));
  assert.match(m, /Closes #12/);
});
