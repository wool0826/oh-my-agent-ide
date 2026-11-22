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
});

test('md: everything is escaped, headings and code blocks still work', () => {
  assert.equal(mdHtml('<script>x</script>'), '<p>&lt;script&gt;x&lt;/script&gt;</p>');
  assert.equal(mdHtml('## Title\nbody'), '<b class="mh">Title</b><p>body</p>');
  assert.equal(mdHtml('```ts\nconst a = 1 < 2;\n```'), '<pre>const a = 1 &lt; 2;</pre>');
  assert.equal(mdHtml('one\ntwo\n\nthree'), '<p>one<br>two</p><p>three</p>');
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
