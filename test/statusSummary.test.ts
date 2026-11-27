import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brief, ordered, SHORT_MAX, tagOf, tally, type StatusItem } from '../src/shared/statusSummary';

const row = (id: string, tone: StatusItem['tone'], name = id): StatusItem => ({ id, name, tone, short: '', fields: [] });

test('status: a short value is kept whole and is not marked as cut', () => {
  assert.deepEqual(brief('git version 2.47.1'), { short: 'git version 2.47.1', full: 'git version 2.47.1', cut: false });
});

test('status: a long path keeps its last folders that fit, and the whole path stays in full', () => {
  const p = '/Users/me/Library/Application Support/oh-my-agent-ide/profiles/default';
  const b = brief(p, 'path');
  assert.equal(b.short, '…/oh-my-agent-ide/profiles/default');
  assert.ok(b.short.length <= SHORT_MAX);
  assert.equal(b.full, p);
  assert.equal(b.cut, true);
});

test('status: a Windows path keeps its backslashes, and one long folder name is cut to fit', () => {
  assert.equal(brief('C:\\Users\\me\\AppData\\Roaming\\oh-my-agent-ide', 'path', 26).short, '…\\Roaming\\oh-my-agent-ide');
  const long = brief(`/data/${'x'.repeat(80)}`, 'path', 20).short;
  assert.equal(long.length, 20);
  assert.ok(long.startsWith('…/x') && long.endsWith('…'));
});

test('status: a long error keeps what went wrong, without its JSON body or what follows a dash', () => {
  const e = 'Usage read failed (429 Too Many Requests): {"type":"error","error":{"type":"rate_limit_error","message":"Number of requests has exceeded your rate limit."}} — retry after 2026-11-27T05:14:00Z';
  const b = brief(e, 'error', 60);
  assert.equal(b.short, 'Usage read failed (429 Too Many Requests)');
  assert.equal(b.full, e);
  assert.equal(b.cut, true);
});

test('status: a file error keeps its code and words, not the file it names', () => {
  assert.equal(brief("EACCES: permission denied, open '/Users/me/Library/Application Support/oh-my-agent-ide/.write-test-42'", 'error').short, 'EACCES: permission denied');
  assert.equal(brief('Error: ENOENT: no such file or directory, stat "/x"', 'error').short, 'ENOENT: no such file or directory');
});

test('status: an error of several sentences or lines keeps the first, and a long one is cut to the limit', () => {
  assert.equal(brief('You are not logged into any GitHub hosts. To log in, run: gh auth login\nmore', 'error').short, 'You are not logged into any GitHub hosts');
  const s = brief('x'.repeat(200), 'error').short;
  assert.equal(s.length, SHORT_MAX);
  assert.ok(s.endsWith('…'));
});

test('status: a version is the number in the tool output', () => {
  assert.equal(brief('git version 2.47.1.windows.2', 'version').short, '2.47.1');
  assert.equal(brief('codex-cli 0.63.0-alpha.3', 'version').short, '0.63.0-alpha.3');
  assert.equal(brief('gh version 2.62.0 (2024-11-14)\nhttps://github.com/cli/cli/releases/tag/v2.62.0', 'version').short, '2.62.0');
});

test('status: many accounts show the first name and how many more, and all of them in full', () => {
  const b = brief(['Work (Team)', 'Personal', 'Backup', 'ChatGPT'], 'list');
  assert.deepEqual(b, { short: 'Work (Team) +3', full: 'Work (Team), Personal, Backup, ChatGPT', cut: true });
  assert.deepEqual(brief(['Only'], 'list'), { short: 'Only', full: 'Only', cut: false });
  assert.deepEqual(brief([], 'list'), { short: '', full: '', cut: false });
  assert.ok(brief([`A ${'very '.repeat(20)}long name`, 'B'], 'list').short.endsWith('… +1'));
});

test('status: text is put on one line and cut to the limit', () => {
  assert.deepEqual(brief('a\n  b\tc'), { short: 'a b c', full: 'a\n  b\tc', cut: true });
  assert.equal(brief('y'.repeat(100), 'text', 10).short, `${'y'.repeat(9)}…`);
});

test('status: rows that need something come first, bad before warnings, each in its own order', () => {
  assert.deepEqual(ordered([row('a', 'ok'), row('b', 'warn'), row('c', 'bad'), row('d', 'ok'), row('e', 'bad')]).map((x) => x.id), ['c', 'e', 'b', 'a', 'd']);
});

test('status: the summary names each row that needs something once, by the part before its colon', () => {
  assert.equal(tagOf('GitHub sign-in: github.company.com'), 'GitHub sign-in');
  const t = tally([row('git', 'ok'), row('a1', 'bad', 'GitHub sign-in: github.com'), row('a2', 'bad', 'GitHub sign-in: company'), row('home', 'warn', 'IDE home folder')]);
  assert.deepEqual(t, { tags: [{ tag: 'GitHub sign-in', tone: 'bad' }, { tag: 'IDE home folder', tone: 'warn' }], more: 0, ok: 1, total: 4 });
});

test('status: past the limit, the summary counts the names it leaves out', () => {
  const t = tally(['a', 'b', 'c', 'd', 'e'].map((x) => row(x, 'bad')), 3);
  assert.deepEqual([t.tags.map((x) => x.tag), t.more, t.ok], [['a', 'b', 'c'], 2, 0]);
});
