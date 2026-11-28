import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  artifactUrl, exportCounts, exportFileName, exportMarkdown, exportShots, hidePaths, insideDir, PATCH_LINES, previewLines, prNumber,
  publishTitle, publishToolOk,
  type ExportSource, type ExportWords,
} from '../src/shared/exportMd';
import { redact, redactCount } from '../src/shared/diagnostics';

const W: ExportWords = {
  report: 'Report', chat: 'Conversation', changes: 'Changes', shots: 'Screenshots',
  who: { user: 'You', worker: 'Worker', dispatcher: 'Dispatcher', auto: 'Auto' },
  ci: { passing: 'passing', failing: 'failing', pending: 'pending', none: 'none', merged: 'merged', closed: 'closed' },
  mask: '[hidden]',
  time: (iso) => iso.slice(11, 16),
  more: (n) => `… ${n} more lines`,
};

const src = (over: Partial<ExportSource> = {}): ExportSource => ({
  worker: { id: 'W-05', title: 'Usage', repo: 'oh-my-agent-ide' },
  tasks: [{
    id: 'T-0181', title: 'Usage forecast', branch: 'agent/t-0181', prUrl: 'https://github.com/o/r/pull/251', prState: 'OPEN',
    prChecks: { ci: 'passing', failed: [], conflicts: false, review: null }, summary: 'Done.', files: ['C:\\Users\\kim\\shots\\a-after.png', 'C:\\Users\\kim\\out\\r.md'],
    links: ['https://claude.ai/artifact/abc'],
  }],
  log: [
    { ts: '2026-11-28T10:00:00Z', from: 'dispatcher', text: '[Task T-0181] go' },
    { ts: '2026-11-28T10:01:00Z', from: 'event', text: 'Started' },
    { ts: '2026-11-28T10:02:00Z', from: 'worker', text: 'env: ANTHROPIC_API_KEY=sk-ant-abcdefghijkl1234' },
    { ts: '2026-11-28T10:03:00Z', from: 'user', text: '  ' },
  ],
  diff: [{ path: 'src/a.ts', added: 2, removed: 1, status: 'M', patch: '@@ -1 +1,2 @@\n-a\n+b\n+c\n' }],
  home: 'C:\\Users\\kim',
  ...over,
});

test('exportMd: each part counts messages without events or blank lines, reports, changed files and images', () => {
  assert.deepEqual(exportCounts(src()), { chat: 2, report: 1, diff: 1, shots: 1 });
  assert.deepEqual(exportShots(src()), ['C:\\Users\\kim\\shots\\a-after.png']);
});

test('exportMd: the heading names the latest task, then its PR with CI, then the Worker, repository and branch', () => {
  const { md } = exportMarkdown(src(), ['report'], W);
  const lines = md.split('\n');
  assert.equal(lines[0], '## T-0181 Usage forecast');
  assert.equal(lines[2], '- PR #251 · CI passing · https://github.com/o/r/pull/251');
  assert.equal(lines[3], '- W-05 · oh-my-agent-ide · agent/t-0181');
});

test('exportMd: a merged PR says merged, and a Worker without a task is named after itself', () => {
  const merged = src();
  merged.tasks[0].prState = 'MERGED';
  assert.match(exportMarkdown(merged, [], W).md, /- PR #251 · merged ·/);
  const none = exportMarkdown(src({ tasks: [] }), [], W).md;
  assert.match(none, /^## W-05 Usage\n\n- W-05 · oh-my-agent-ide\n$/);
});

test('exportMd: only the picked parts are written, in the order report, conversation, changes, screenshots', () => {
  const all = exportMarkdown(src(), ['shots', 'diff', 'chat', 'report'], W).md;
  const at = (h: string) => all.indexOf(`### ${h}`);
  assert.ok(at('Report') > 0 && at('Report') < at('Conversation') && at('Conversation') < at('Changes') && at('Changes') < at('Screenshots'));
  const some = exportMarkdown(src(), ['chat'], W).md;
  assert.ok(!some.includes('### Report') && !some.includes('### Changes') && some.includes('**Dispatcher** · 10:00'));
  assert.ok(!some.includes('Started'));
});

test('exportMd: a patch goes in a diff block, and a long one is cut with the lines left out counted', () => {
  assert.match(exportMarkdown(src(), ['diff'], W).md, /#### `src\/a\.ts` \+2 −1\n\n```diff\n@@ -1 \+1,2 @@\n-a\n\+b\n\+c\n```/);
  const long = { path: 'big.ts', added: PATCH_LINES + 10, removed: 0, status: 'A' as const, patch: Array.from({ length: PATCH_LINES + 10 }, (_x, i) => `+${i}`).join('\n') };
  const md = exportMarkdown(src({ diff: [long] }), ['diff'], W).md;
  assert.match(md, /```\n\n… 10 more lines/);
  assert.ok(!md.includes(`+${PATCH_LINES}\n`));
});

test('exportMd: a patch holding a code fence gets a longer fence', () => {
  const d = { path: 'README.md', added: 2, removed: 0, status: 'M' as const, patch: '+```js\n+x\n' };
  assert.match(exportMarkdown(src({ diff: [d] }), ['diff'], W).md, /````diff\n\+```js\n\+x\n````/);
});

test('exportMd: tokens and the user name in home paths are hidden and counted apart', () => {
  const r = exportMarkdown(src(), ['chat', 'report', 'shots'], W);
  assert.ok(r.md.includes('env: ANTHROPIC_API_KEY=[hidden]'));
  assert.ok(!r.md.includes('sk-ant-abc'));
  assert.ok(r.md.includes('C:/Users/[hidden]/shots/a-after.png'));
  assert.ok(!/kim/i.test(r.md));
  assert.deepEqual(r.hidden, { total: 2, tokens: 1, paths: 1 });
});

test('exportMd: home paths are found with either slash and any case, but not a longer name', () => {
  assert.deepEqual(hidePaths('c:/users/KIM/x and C:\\\\Users\\\\kim\\\\y', 'C:\\Users\\kim', '[h]'), { text: 'c:/users/[h]/x and C:\\\\Users\\\\[h]\\\\y', n: 2 });
  assert.deepEqual(hidePaths('/home/kimberly/x', '/home/kim', '[h]'), { text: '/home/kimberly/x', n: 0 });
  assert.deepEqual(hidePaths('/home/kim/x', '/home/kim', '[h]'), { text: '/home/[h]/x', n: 1 });
  assert.deepEqual(hidePaths('/x', '/', '[h]'), { text: '/x', n: 0 });
});

test('exportMd: the redaction with a mask keeps what comes before the value, and without one stays as it was', () => {
  assert.deepEqual(redactCount('Bearer abcdefgh1234 and ghp_abcdefghijklmnop12', '[h]'), { text: 'Bearer [h] and ghp_[h]', n: 2 });
  assert.equal(redact('token: "abc"'), 'token: "***"');
  assert.deepEqual(redactCount('nothing here'), { text: 'nothing here', n: 0 });
});

test('exportMd: the preview shows the heading, the next line, then the lines with hidden values', () => {
  const md = '## T-1 x\n\n- PR #2 · CI passing\n- W-1\n\nplain\nkey: [h]\nmore\nC:/Users/[h]/a\n';
  assert.deepEqual(previewLines(md, '[h]'), ['## T-1 x', '- PR #2 · CI passing', 'key: [h]', 'C:/Users/[h]/a']);
  assert.deepEqual(previewLines('## a\n- b\nc\n', '[h]'), ['## a', '- b', 'c']);
});

test('exportMd: the artifact link is read from a reply, the last when there are several', () => {
  assert.equal(artifactUrl('Published: https://claude.ai/artifact/Xa9_b-1.'), 'https://claude.ai/artifact/Xa9_b-1');
  assert.equal(artifactUrl('a https://claude.ai/artifact/one then https://claude.ai/code/artifact/two'), 'https://claude.ai/code/artifact/two');
  assert.equal(artifactUrl('no link'), null);
  assert.equal(artifactUrl(null), null);
});

test('exportMd: the saved file is named after the task, else the Worker, and a PR number is read from its link', () => {
  assert.equal(exportFileName(src()), 'T-0181.md');
  assert.equal(exportFileName(src({ tasks: [] })), 'W-05.md');
  assert.equal(prNumber('https://github.com/o/r/pull/12'), '12');
  assert.equal(prNumber(null), null);
});

test('exportMd: a screenshot link survives spaces, brackets and parentheses in its path', () => {
  const md = exportMarkdown(src({ tasks: [{ ...src().tasks[0], files: ['D:\\shots (1)\\a [x].png'] }] }), ['shots'], W).md;
  assert.ok(md.includes('![a x.png](D:/shots%20%281%29/a%20%5Bx%5D.png)'));
});

test('exportMd: a file is inside the publish folder when relative without .., or under it with any slash and case', () => {
  const dir = 'C:\\Temp\\oma-export-1';
  assert.ok(insideDir('page.html', dir));
  assert.ok(insideDir('c:/temp/OMA-EXPORT-1/page.html', dir));
  assert.ok(!insideDir('../secret.txt', dir));
  assert.ok(!insideDir('C:\\Temp\\oma-export-1\\..\\x', dir));
  assert.ok(!insideDir('C:\\Temp\\oma-export-10\\x', dir));
  assert.ok(!insideDir('~/.ssh/id_rsa', dir));
});

test('exportMd: the publishing session gets its own tools and files only', () => {
  const dir = '/tmp/oma-export-1';
  assert.ok(publishToolOk('Write', { file_path: '/tmp/oma-export-1/page.html', content: '/etc/passwd' }, dir));
  assert.ok(!publishToolOk('Read', { file_path: '/home/kim/.ssh/id_rsa' }, dir));
  assert.ok(!publishToolOk('Edit', {}, dir));
  assert.ok(publishToolOk('Artifact', { file_path: 'page.html', icon: 'doc', files: { 'shot-1.png': 'shot-1.png' } }, dir));
  assert.ok(!publishToolOk('Artifact', { file_path: 'page.html', files: { 'k.txt': { from: '/home/kim/.aws/credentials' } } }, dir));
  assert.ok(publishToolOk('Artifact', { action: 'read', url: 'https://claude.ai/artifact/x' }, dir));
  assert.ok(!publishToolOk('Bash', { command: 'ls' }, dir));
});

test('exportMd: the artifact title is the export heading on one short line', () => {
  assert.equal(publishTitle('## T-1 a "b"\n\nx'), 'T-1 a b');
  assert.equal(publishTitle(`## ${'x'.repeat(200)}`).length, 120);
});
