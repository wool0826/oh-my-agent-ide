import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addMention, chipFold, dropMention, mentionAt, mentionBlock, mentionRows, prNumber, repoWhere, splitMentions, type MentionSources } from '../src/shared/mentions';
import type { Mention } from '../src/shared/types';

const words = { done: '완료', merged: '머지', closed: '닫힘' };

const task = (id: string, title: string, over: Partial<MentionSources['tasks'][number]> = {}): MentionSources['tasks'][number] => ({
  id, title, repo: 'app', workerId: 'W-01', status: 'running', prUrl: null, prState: null, updatedAt: '2026-11-01T00:00:00Z', ...over,
});

const src: MentionSources = {
  repos: [{ name: 'oh-my-agent-ide', where: 'GitHub' }, { name: 'agent-docs', where: 'D:/project' }],
  files: [
    { repo: 'oh-my-agent-ide', path: 'src/renderer/ui/settings.ts' },
    { repo: 'oh-my-agent-ide', path: 'src/renderer/settings.css' },
    { repo: 'oh-my-agent-ide', path: 'test/unit/settings.test.ts' },
    { repo: 'oh-my-agent-ide', path: 'src/main/presettings.ts' },
    { repo: 'oh-my-agent-ide', path: 'README.md' },
  ],
  tasks: [
    task('T-0174', 'Settings search', { workerId: 'W-05', updatedAt: '2026-11-03T00:00:00Z' }),
    task('T-0171', 'Window size', { status: 'done', prUrl: 'https://github.com/o/r/pull/241', prState: 'MERGED', updatedAt: '2026-11-02T00:00:00Z' }),
    task('T-0176', 'Prompt history', { prUrl: 'https://github.com/o/r/pull/243', prState: 'OPEN', updatedAt: '2026-11-04T00:00:00Z' }),
  ],
  workers: [
    { id: 'W-05', title: 'w5', status: 'running', taskIds: ['T-0174'] },
    { id: 'W-09', title: 'w9', status: 'archived', taskIds: [] },
  ],
};

test('mentions: "@" opens at the start or after a space, and not inside a word', () => {
  assert.deepEqual(mentionAt('@', 1), { start: 0, query: '' });
  assert.deepEqual(mentionAt('look at @sett', 13), { start: 8, query: 'sett' });
  assert.deepEqual(mentionAt('line\n@x', 7), { start: 5, query: 'x' });
  assert.equal(mentionAt('mail@host', 9), null);
  assert.equal(mentionAt('@sett now', 9), null);
  assert.equal(mentionAt('@a@b', 4), null);
});

test('mentions: a pick takes the "@" and what was typed out of the text', () => {
  assert.deepEqual(dropMention('fix @sett please', { start: 4, query: 'sett' }), { value: 'fix  please', caret: 4 });
});

test('mentions: a PR number comes from its URL', () => {
  assert.equal(prNumber('https://github.com/o/r/pull/243'), 243);
  assert.equal(prNumber(null), null);
  assert.equal(prNumber('https://github.com/o/r/issues/3'), null);
});

test('mentions: a clone the app keeps is on GitHub; another repository shows its parent folder', () => {
  assert.equal(repoWhere({ path: 'C:\\Users\\a\\oma\\repos\\app', url: 'https://github.com/o/app.git' }, 'C:\\Users\\a\\oma\\repos'), 'GitHub');
  assert.equal(repoWhere({ path: 'C:\\Users\\a\\oma\\repos\\app', url: 'git@gitlab.com:o/app.git' }, 'C:\\Users\\a\\oma\\repos'), 'gitlab.com');
  assert.equal(repoWhere({ path: 'D:/project/agent-docs', url: '' }, 'C:\\Users\\a\\oma\\repos'), 'D:/project');
});

test('mentions: with nothing typed, three of each group and no files', () => {
  const r = mentionRows(src, '', words);
  assert.equal(r.file.length, 0);
  assert.deepEqual(r.repo.map((x) => x.mention.label), ['oh-my-agent-ide', 'agent-docs']);
  // Newest first; a PR shows its repository, or that it was merged.
  assert.deepEqual(r.pr.map((x) => [x.mention.label, x.meta]), [['#243', 'app'], ['#241', '머지']]);
  assert.deepEqual(r.task.map((x) => [x.mention.label, x.meta]), [['T-0176', 'W-01'], ['T-0174', 'W-05'], ['T-0171', '완료']]);
  // An archived Worker is not listed; a Worker shows its last task.
  assert.deepEqual(r.worker.map((x) => [x.mention.label, x.meta]), [['W-05', 'Settings search']]);
});

test('mentions: typed text lists files by name first, then by path, with the folder beside them', () => {
  const r = mentionRows(src, 'Sett', words);
  assert.deepEqual(r.file.map((x) => x.mention.label), ['settings.ts', 'settings.css', 'settings.test.ts', 'presettings.ts']);
  assert.equal(r.file[0].meta, 'src/renderer/ui');
  assert.equal(r.file[0].mention.repo, 'oh-my-agent-ide');
  assert.deepEqual(r.task.map((x) => x.mention.label), ['T-0174']);
  assert.deepEqual(r.repo, []);
});

test('mentions: a file at the top of a repository shows the repository beside it', () => {
  assert.equal(mentionRows(src, 'readme', words).file[0].meta, 'oh-my-agent-ide');
});

test('mentions: a PR is found by its number', () => {
  assert.deepEqual(mentionRows(src, '#24', words).pr.map((x) => x.mention.label), ['#243', '#241']);
  assert.deepEqual(mentionRows(src, '241', words).pr.map((x) => x.mention.label), ['#241']);
});

test('mentions: the same mention is not added twice', () => {
  const a: Mention = { kind: 'repo', id: 'app', label: 'app' };
  const one = addMention([], a);
  assert.equal(addMention(one, { ...a }).length, 1);
  assert.equal(addMention(one, { kind: 'file', id: 'app', label: 'app', repo: 'x' }).length, 2);
});

test('mentions: past four chips the rest fold into "+N", never "+1"', () => {
  assert.deepEqual(chipFold([1, 2, 3, 4, 5], false), { shown: [1, 2, 3, 4, 5], more: 0 });
  assert.deepEqual(chipFold([1, 2, 3, 4, 5, 6], false), { shown: [1, 2, 3, 4], more: 2 });
  assert.deepEqual(chipFold([1, 2, 3, 4, 5, 6], true), { shown: [1, 2, 3, 4, 5, 6], more: 0 });
});

test('mentions: the block names each mention on a line and is read back into chips', () => {
  const list: Mention[] = [
    { kind: 'repo', id: 'app', label: 'app' },
    { kind: 'file', id: 'src/a/b.ts', label: 'b.ts', repo: 'app' },
    { kind: 'pr', id: 'https://github.com/o/r/pull/243', label: '#243', title: 'Line\nbreak', repo: 'app' },
    { kind: 'task', id: 'T-0176', label: 'T-0176', title: 'Prompt history' },
    { kind: 'worker', id: 'W-05', label: 'W-05' },
  ];
  const block = mentionBlock(list);
  assert.equal(block, [
    '\n\n[Mentioned]',
    '- repository app',
    '- file src/a/b.ts — app',
    '- PR #243 — Line break; https://github.com/o/r/pull/243; app',
    '- task T-0176 — Prompt history',
    '- Worker W-05',
  ].join('\n'));
  assert.equal(mentionBlock([]), '');
  const back = splitMentions(`fix it${block}`);
  assert.equal(back.text, 'fix it');
  assert.deepEqual(back.mentions, list.map((m) => ({ kind: m.kind, label: m.label })));
});

test('mentions: attached files after the block stay in the text', () => {
  const text = `hi${mentionBlock([{ kind: 'worker', id: 'W-01', label: 'W-01' }])}\n\n[Attached files]\n- C:/a.png`;
  assert.deepEqual(splitMentions(text), { text: 'hi\n\n[Attached files]\n- C:/a.png', mentions: [{ kind: 'worker', label: 'W-01' }] });
  assert.deepEqual(splitMentions('plain'), { text: 'plain', mentions: [] });
});

test('mentions: a path with brackets reads back whole', () => {
  const list: Mention[] = [{ kind: 'file', id: 'docs/a (1).md', label: 'a (1).md', repo: 'app' }, { kind: 'repo', id: 'b (old)', label: 'b (old)' }];
  assert.deepEqual(splitMentions(`x${mentionBlock(list)}`).mentions, [{ kind: 'file', label: 'a (1).md' }, { kind: 'repo', label: 'b (old)' }]);
});

test('mentions: "[Mentioned]" typed in a message is not a block', () => {
  const typed = 'about\n\n[Mentioned]\nsome words';
  assert.deepEqual(splitMentions(typed), { text: typed, mentions: [] });
  const both = `${typed}${mentionBlock([{ kind: 'worker', id: 'W-01', label: 'W-01' }])}`;
  assert.deepEqual(splitMentions(both), { text: typed, mentions: [{ kind: 'worker', label: 'W-01' }] });
});

test('mentions: a long file list gives the first matches by name, then by path', () => {
  const files = Array.from({ length: 50_000 }, (_, i) => ({ repo: 'r', path: `src/m${i}/x${i}.ts` }));
  const t0 = Date.now();
  const r = mentionRows({ ...src, files }, 'x1', words).file;
  assert.equal(r.length, 6);
  assert.ok(r.every((x) => x.mention.label.startsWith('x1')));
  assert.ok(Date.now() - t0 < 500);
});
