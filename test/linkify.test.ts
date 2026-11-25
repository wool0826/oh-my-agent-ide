import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkify, reportLinks, resultLinkList, shortUrls, urlEnd } from '../src/shared/linkify';

const PR = 'https://github.com/wool0826/oh-my-agent-ide/pull/27';
const a = (url: string) => `<a tabindex="0" role="link" data-action="open-url" data-href="${url}">${url}</a>`;

test('a sentence-ending period stays outside the link', () => {
  assert.equal(linkify(`Opened ${PR}. CI is running.`), `Opened ${a(PR)}. CI is running.`);
  assert.equal(linkify(`${PR}.`), `${a(PR)}.`);
});

test('other trailing punctuation stays outside too', () => {
  for (const p of [',', ';', ':', '!', '?', '...', '?!']) assert.equal(linkify(`${PR}${p} next`), `${a(PR)}${p} next`);
});

test('a Korean particle stuck to the URL stays outside', () => {
  assert.equal(linkify(`${PR}을 확인해 주세요.`), `${a(PR)}을 확인해 주세요.`);
  assert.equal(linkify(`PR은 ${PR}입니다.`), `PR은 ${a(PR)}입니다.`);
});

test('a closing bracket belongs to the URL only with its opening one', () => {
  assert.equal(linkify(`(see ${PR})`), `(see ${a(PR)})`);
  assert.equal(linkify(`(${PR}).`), `(${a(PR)}).`);
  assert.equal(linkify(`[PR](${PR})`), `[PR](${a(PR)})`);
  assert.equal(linkify(`[${PR}]`), `[${a(PR)}]`);
  const wiki = 'https://example.com/wiki/Queue_(waiting)';
  assert.equal(linkify(`문서(${wiki})도 고쳤습니다.`), `문서(${a(wiki)})도 고쳤습니다.`);
});

test('dots, queries and fragments inside the URL are kept', () => {
  const u = 'https://example.com/a.b/c.html?x=1&amp;y=2#top';
  assert.equal(linkify(`${u}.`), `${a(u)}.`);
  const amp = 'https://example.com/?q=a&amp;';
  assert.equal(linkify(amp), a(amp));
});

test('an escaped quote or angle bracket ends the URL', () => {
  assert.equal(linkify(`&quot;${PR}&quot; and &lt;${PR}&gt;`), `&quot;${a(PR)}&quot; and &lt;${a(PR)}&gt;`);
  assert.equal(linkify(`&#39;${PR}&#39;.`), `&#39;${a(PR)}&#39;.`);
});

test('text without a real URL is left alone', () => {
  assert.equal(linkify('no links here.'), 'no links here.');
  assert.equal(linkify('https://. and http://'), 'https://. and http://');
});

test('several URLs in one text', () => {
  const other = 'https://github.com/wool0826/oh-my-agent-ide/pull/26';
  assert.equal(linkify(`${other}, ${PR}.`), `${a(other)}, ${a(PR)}.`);
});

test('urlEnd gives the length of the URL in a run', () => {
  assert.equal(urlEnd(`${PR}.`), PR.length);
  assert.equal(urlEnd(PR), PR.length);
});

test('a report names its links once each, by a short name, without the task\'s own PR', () => {
  const text = `RESULT: Published [Release notes 0.7](https://claude.ai/artifact/2hL45) and opened ${PR}.\nPR: ${PR}\nAlso https://claude.ai/code/artifact/ab-12, https://www.example.com/x and https://claude.ai/artifact/2hL45 again.`;
  assert.deepEqual(reportLinks(text), [
    { url: 'https://claude.ai/artifact/2hL45', kind: 'artifact', name: 'Release notes 0.7' },
    { url: PR, kind: 'pr', name: '27' },
    { url: 'https://claude.ai/code/artifact/ab-12', kind: 'artifact', name: '' },
    { url: 'https://www.example.com/x', kind: 'link', name: 'example.com' },
  ]);
  assert.deepEqual(reportLinks(text, [PR]).map((l) => l.kind), ['artifact', 'artifact', 'link']);
  assert.deepEqual(reportLinks('no links here'), []);
});

test('a line that cannot hold links reads the short names', () => {
  assert.equal(shortUrls(`Published https://claude.ai/artifact/2hL45 and ${PR}.`, 'Artifact'), 'Published Artifact and PR #27.');
  assert.equal(shortUrls('See [the notes](https://claude.ai/artifact/2hL45).', 'Artifact'), 'See the notes.');
});

test('emphasis around a URL and a trailing slash do not change which link it is', () => {
  assert.deepEqual(reportLinks('See **https://example.com/a** and [Docs](https://example.com/d/) at https://example.com/d'),
    [{ url: 'https://example.com/a', kind: 'link', name: 'example.com' }, { url: 'https://example.com/d/', kind: 'link', name: 'Docs' }]);
});

test('full-width punctuation after a URL is not part of it', () => {
  const art = 'https://claude.ai/artifact/2hL4515n1HmJCSDrwV96T7';
  assert.equal(linkify(`보고서（${art}）를 보세요`), `보고서（${a(art)}）를 보세요`);
  assert.deepEqual(reportLinks(`${art}、다음 ${art}。`).map((l) => l.url), [art]);
  assert.equal(shortUrls(`게시함（${art}）`, 'Artifact'), '게시함（Artifact）');
});

test('a report keeps the artifacts and PRs it names, and every URL on its LINK and FILE lines', () => {
  const text = [
    'RESULT: Wrote the audit',
    `PR: ${PR}`,
    'LINK: https://example.com/notes',
    'FILE: https://claude.ai/code/artifact/0b7c9e1a-1f2d-4c3b-9a8e-123456789abc',
    '',
    '아티팩트: [UI audit](https://claude.ai/artifact/2hL4515n1HmJCSDrwV96T7)',
    'Also https://github.com/o/r/pull/9, see https://docs.example.com/guide for background.',
  ].join('\n');
  assert.deepEqual(resultLinkList(text, [PR]), [
    'https://example.com/notes',
    'https://claude.ai/code/artifact/0b7c9e1a-1f2d-4c3b-9a8e-123456789abc',
    '[UI audit](https://claude.ai/artifact/2hL4515n1HmJCSDrwV96T7)',
    'https://github.com/o/r/pull/9',
  ]);
  // A kept title reads back as the link's name.
  assert.equal(reportLinks(resultLinkList(text, [PR]).join('\n'))[2].name, 'UI audit');
  assert.deepEqual(resultLinkList('RESULT: Done'), []);
});
