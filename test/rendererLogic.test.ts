// Renderer rules kept in src/shared so they can be tested: markdown, Stop, the Worker composer's answer target,
// and the time a task entered the queue.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mdHtml } from '../src/shared/markdown';
import { canStop } from '../src/shared/canStop';
import { answerTarget, composerAnswers } from '../src/shared/inbox';
import { stampQueued } from '../src/shared/queue';
import type { Decision, Task } from '../src/shared/types';

test('md: lists, ordered lists and nested items', () => {
  assert.equal(mdHtml('Done:\n\n- one\n- two `x`\n  - deeper'), '<p>Done:</p><ul><li>one</li><li>two <code>x</code></li><li class="sub">deeper</li></ul>');
  assert.equal(mdHtml('1. first\n2. second'), '<ol><li>first</li><li>second</li></ol>');
  assert.equal(mdHtml('3. third\n4. fourth'), '<ol start="3"><li>third</li><li>fourth</li></ol>');
  // A paragraph right before a list ends at it.
  assert.equal(mdHtml('Changes\n* a\n* b'), '<p>Changes</p><ul><li>a</li><li>b</li></ul>');
  // A line indented under an item goes with it.
  assert.equal(mdHtml('- item\n  more of it'), '<ul><li>item<br>more of it</li></ul>');
});

test('md: tables', () => {
  const h = mdHtml('| Command | Result |\n|---|:---:|\n| `npm test` | pass |\n| build | **ok** |');
  assert.equal(h, '<div class="md-table"><table><thead><tr><th>Command</th><th>Result</th></tr></thead><tbody><tr><td><code>npm test</code></td><td>pass</td></tr><tr><td>build</td><td><b>ok</b></td></tr></tbody></table></div>');
  // Pipes without the rule line are plain text.
  assert.equal(mdHtml('a | b'), '<p>a | b</p>');
});

test('md: italics, without touching snake_case, URLs or code', () => {
  assert.equal(mdHtml('an *important* and _quiet_ word'), '<p>an <i>important</i> and <i>quiet</i> word</p>');
  assert.equal(mdHtml('snake_case_name and 2 * 3 * 4'), '<p>snake_case_name and 2 * 3 * 4</p>');
  assert.equal(mdHtml('`a*b*c`'), '<p><code>a*b*c</code></p>');
  assert.match(mdHtml('see https://x.dev/a_b_c'), /data-href="https:\/\/x.dev\/a_b_c"/);
  assert.match(mdHtml('see https://x.dev/*all*/y'), /data-href="https:\/\/x.dev\/\*all\*\/y"/);
  assert.equal(mdHtml('(*aside*) and **bold**'), '<p>(<i>aside</i>) and <b>bold</b></p>');
});

test('md: everything is escaped, headings and code blocks still work', () => {
  assert.equal(mdHtml('<script>x</script>'), '<p>&lt;script&gt;x&lt;/script&gt;</p>');
  assert.equal(mdHtml('## Title\nbody'), '<b class="mh">Title</b><p>body</p>');
  assert.equal(mdHtml('```ts\nconst a = 1 < 2;\n```'), '<pre>const a = 1 &lt; 2;</pre>');
  assert.equal(mdHtml('one\ntwo\n\nthree'), '<p>one<br>two</p><p>three</p>');
});

test('md: [text](url) links, with brackets in the text and parentheses in the URL', () => {
  const a = (url: string, text: string) => `<a data-action="open-url" data-href="${url}" title="${url}">${text}</a>`;
  assert.equal(mdHtml('Sources:\n- [Docs](https://x.dev/a)'), `<p>Sources:</p><ul><li>${a('https://x.dev/a', 'Docs')}</li></ul>`);
  assert.equal(mdHtml('[[Bug] spawn (gh) fails](https://github.com/o/r/issues/1)'), `<p>${a('https://github.com/o/r/issues/1', '[Bug] spawn (gh) fails')}</p>`);
  assert.equal(mdHtml('see [wiki](https://en.wikipedia.org/wiki/Queue_(abstract)).'), `<p>see ${a('https://en.wikipedia.org/wiki/Queue_(abstract)', 'wiki')}.</p>`);
  assert.equal(mdHtml('[**bold** name](https://a.io)'), `<p>${a('https://a.io', '<b>bold</b> name')}</p>`);
  // Not http(s), or no URL: left as written.
  assert.equal(mdHtml('[x](javascript:alert(1)) [y] [z](relative)'), '<p>[x](javascript:alert(1)) [y] [z](relative)</p>');
  // Quotes cannot break out of the attribute.
  assert.equal(mdHtml('[x](https://a.io/"onmouseover="y)'), '<p>[x](<a data-action="open-url" data-href="https://a.io/">https://a.io/</a>&quot;onmouseover=&quot;y)</p>');
  assert.equal(mdHtml('[<img src=x>](https://a.io)'), `<p>${a('https://a.io', '&lt;img src=x&gt;')}</p>`);
  assert.equal(mdHtml('`[a](https://a.io)`'), '<p><code>[a](https://a.io)</code></p>');
  assert.equal(mdHtml('[`foo.ts`](https://a.io) 2 [b](https://b.io?x=1&y=_2_)'), `<p>${a('https://a.io', '<code>foo.ts</code>')} 2 ${a('https://b.io?x=1&amp;y=_2_', 'b')}</p>`);
  assert.equal(mdHtml('\u00000\u0000 [[x](https://a.io)'), `<p>0 [${a('https://a.io', 'x')}</p>`);
  assert.equal(mdHtml('['.repeat(20000)).length, 20007);
});

test('md: quotes, rules and bold italics', () => {
  assert.equal(mdHtml('> quoted **text**\n> - item\n\nafter'), '<blockquote><p>quoted <b>text</b></p><ul><li>item</li></ul></blockquote><p>after</p>');
  assert.equal(mdHtml('one\n\n---\n\ntwo'), '<p>one</p><hr><p>two</p>');
  assert.equal(mdHtml('***'), '<hr>');
  assert.equal(mdHtml('> > deep'), '<blockquote><blockquote><p>deep</p></blockquote></blockquote>');
  assert.match(mdHtml('| a | b |\n|---|---|\n| 1 | 2 |'), /^<div class="md-table">/);
  assert.equal(mdHtml('***both***'), '<p><b><i>both</i></b></p>');
});

test('canStop: one rule for every place that offers Stop', () => {
  const w = (status: string, request: object | null = null) => ({ status, request }) as never;
  for (const st of ['running', 'starting', 'waiting']) assert.equal(canStop(w(st), null), true, st);
  for (const st of ['idle', 'error', 'archived']) assert.equal(canStop(w(st), null), false, st);
  // Idle while its task waits for the Dispatcher: the task holds a slot, so Stop is offered.
  assert.equal(canStop(w('idle', { text: 'which branch?' }), { status: 'waiting' }), true);
  assert.equal(canStop(w('idle', { text: 'which branch?' }), { status: 'done' }), false);
  assert.equal(canStop(w('idle'), { status: 'waiting' }), false);
});

const D = (id: string, source: Decision['source'], extra: Partial<Decision> = {}): Decision => ({
  id, source, workerId: 'W-01', taskId: 'T-1', title: `q ${id}`, detail: '', code: null, options: [], status: 'pending', createdAt: '2026-11-22T00:00:00Z', ...extra,
} as Decision);

test('composerAnswers: a question or a plan, never a permission, unless switched to a normal message', () => {
  const perm = D('p', 'permission'), q = D('q', 'question'), plan = D('pl', 'plan');
  assert.equal(composerAnswers([perm], new Set()), null);
  assert.equal(composerAnswers([perm, q], new Set())?.id, 'q');
  assert.equal(composerAnswers([q, plan], new Set(['q']))?.id, 'pl');
  assert.equal(composerAnswers([q], new Set(['q'])), null);
});

test('answerTarget: text answers only the decision the composer named, still open, of that Worker, not a permission', () => {
  const ds = [D('p', 'permission'), D('q', 'question'), D('x', 'question', { workerId: 'W-02' }), D('a', 'question', { status: 'answered' })];
  assert.equal(answerTarget(ds, 'W-01', 'q')?.id, 'q');
  // No id: a normal message, even with a question open.
  assert.equal(answerTarget(ds, 'W-01', null), null);
  // A permission is never denied by text.
  assert.equal(answerTarget(ds, 'W-01', 'p'), null);
  // Answered meanwhile, or another Worker's: a normal message.
  assert.equal(answerTarget(ds, 'W-01', 'a'), null);
  assert.equal(answerTarget(ds, 'W-01', 'x'), null);
});

test('stampQueued: keeps the time a task entered the queue, and clears it once it leaves', () => {
  const t = { status: 'queued', updatedAt: '2026-11-22T10:00:00Z' } as Task;
  assert.equal(stampQueued([t]), true);
  assert.equal(t.queuedSince, '2026-11-22T10:00:00Z');
  // Later updates move updatedAt, not the time it entered the queue.
  t.updatedAt = '2026-11-22T10:30:00Z';
  assert.equal(stampQueued([t]), false);
  assert.equal(t.queuedSince, '2026-11-22T10:00:00Z');
  t.status = 'blocked';
  stampQueued([t]);
  assert.equal(t.queuedSince, '2026-11-22T10:00:00Z');
  t.status = 'running';
  assert.equal(stampQueued([t]), true);
  assert.equal(t.queuedSince, null);
});
