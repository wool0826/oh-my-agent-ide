import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkify, reportLinks, shortUrls, urlEnd } from '../src/shared/linkify';

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
