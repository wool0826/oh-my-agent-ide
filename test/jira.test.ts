import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adfText, jiraAuth, jiraBase, jiraMessage, jiraSearchUrls, parseJiraIssues } from '../src/shared/jira';

test('the site address is cut down to its base, and only https is taken', () => {
  assert.equal(jiraBase('company.atlassian.net'), 'https://company.atlassian.net');
  assert.equal(jiraBase('https://company.atlassian.net/browse/PAY-12'), 'https://company.atlassian.net');
  assert.equal(jiraBase('https://jira.company.com/jira/secure/Dashboard.jspa'), 'https://jira.company.com/jira');
  assert.equal(jiraBase('https://jira.company.com/'), 'https://jira.company.com');
  assert.equal(jiraBase('http://jira.company.com'), null);
  assert.equal(jiraBase('not a url'), null);
  assert.equal(jiraBase(''), null);
});

test('Cloud signs in with email and token, Data Center with the token alone', () => {
  assert.equal(jiraAuth('me@company.com', 'tok'), `Basic ${Buffer.from('me@company.com:tok').toString('base64')}`);
  assert.equal(jiraAuth('', 'tok'), 'Bearer tok');
});

test('Cloud tries its current search first, Data Center only its own', () => {
  const cloud = jiraSearchUrls('https://c.atlassian.net', true);
  assert.equal(cloud.length, 2);
  assert.match(cloud[0], /\/rest\/api\/3\/search\/jql\?jql=assignee/);
  assert.match(cloud[1], /\/rest\/api\/2\/search\?/);
  assert.equal(jiraSearchUrls('https://j.company.com', false).length, 1);
});

test('a description in Atlassian Document Format reads as plain text', () => {
  const adf = { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Tax is ' }, { type: 'text', text: 'wrong' }, { type: 'hardBreak' }, { type: 'text', text: 'on carts.' }] },
    { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'round once' }] }] }] },
  ] };
  assert.equal(adfText(adf), 'Tax is wrong\non carts.\n- round once\n');
  assert.equal(adfText('plain wiki text'), 'plain wiki text');
  assert.equal(adfText(null), '');
});

test('issues are read from a search answer, skipping rows that are not issues', () => {
  const body = { issues: [
    { key: 'PAY-12', fields: { summary: 'Fix tax rounding', status: { name: 'In Progress' }, issuetype: { name: 'Bug' }, updated: '2026-11-20T10:00:00.000+0900', description: 'Round once at the end.' } },
    { key: 'PAY-13', fields: { summary: 'No description', description: null } },
    { nope: true },
  ] };
  const list = parseJiraIssues(body, 'https://c.atlassian.net');
  assert.deepEqual(list.map((i) => [i.key, i.status, i.type, i.url, i.description]), [
    ['PAY-12', 'In Progress', 'Bug', 'https://c.atlassian.net/browse/PAY-12', 'Round once at the end.'],
    ['PAY-13', '', '', 'https://c.atlassian.net/browse/PAY-13', ''],
  ]);
  assert.deepEqual(parseJiraIssues({ errorMessages: ['nope'] }, 'x'), []);
});

test('the message to the Dispatcher carries the issue, since Workers cannot read Jira', () => {
  const m = jiraMessage({ key: 'PAY-12', summary: 'Fix tax rounding', url: 'https://c.atlassian.net/browse/PAY-12', description: 'Round once.' });
  assert.match(m, /^Work on Jira issue PAY-12: Fix tax rounding\nhttps:\/\/c\.atlassian\.net\/browse\/PAY-12\n\nDescription:\nRound once\./);
  assert.match(m, /Put "PAY-12" in the PR title/);
  assert.doesNotMatch(jiraMessage({ key: 'A-1', summary: 's', url: 'u', description: '' }), /Description:/);
});
