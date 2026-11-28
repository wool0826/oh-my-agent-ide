import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BIG_LINES, bigFile, diffLayout, numberedLines, seenCount, seenKey, sizeText, splitRows, SPLIT_MIN, stepFile } from '../src/shared/diffView';
import { highlightDiff, highlightLine, langOf } from '../src/shared/highlight';
import { patchLines } from '../src/shared/diffComment';

const PATCH = '@@ -42,4 +42,5 @@ export function f() {\n const rows = 1;\n-const left = a;\n+const left = b;\n+const eta = 2;\n return x;\n';

test('diffView: side by side only in a pane at least 900 wide, else one column with the switch off', () => {
  assert.deepEqual(diffLayout('split', SPLIT_MIN), { layout: 'split', canSplit: true });
  assert.deepEqual(diffLayout('split', SPLIT_MIN - 1), { layout: 'unified', canSplit: false });
  assert.deepEqual(diffLayout('unified', 1400), { layout: 'unified', canSplit: true });
});

test('diffView: each line gets its old and new number from the hunk header, and the same index as a comment', () => {
  const lines = numberedLines(PATCH);
  assert.deepEqual(lines.map((l) => [l.kind, l.old, l.new]), [['h', null, null], ['ctx', 42, 42], ['del', 43, null], ['add', null, 43], ['add', null, 44], ['ctx', 44, 45]]);
  assert.equal(lines[2].text, 'const left = a;');
  assert.deepEqual(lines.map((l) => l.i), patchLines(PATCH).map((_l, i) => i));
});

test('diffView: side by side puts removed lines next to the ones added in their place, padding the shorter side', () => {
  const rows = splitRows(numberedLines(PATCH));
  const show = rows.map((r) => ('h' in r ? 'h' : `${r.left?.old ?? '-'}|${r.right?.new ?? '-'}`));
  assert.deepEqual(show, ['h', '42|42', '43|43', '-|44', '44|45']);
  const del = splitRows(numberedLines('@@ -1,2 +1 @@\n-a\n-b\n'));
  assert.deepEqual(del.map((r) => ('h' in r ? 'h' : `${r.left?.text ?? '-'}|${r.right?.text ?? '-'}`)), ['h', 'a|-', 'b|-']);
});

test('diffView: a file stays seen until its patch changes', () => {
  const f = { path: 'a.ts', patch: PATCH };
  const seen = new Set([seenKey(f)]);
  assert.equal(seenCount([f, { path: 'b.ts', patch: '' }], seen), 1);
  assert.equal(seenCount([{ ...f, patch: `${PATCH}+x\n` }], seen), 0);
});

test('diffView: a lockfile or a patch over the line limit waits to be expanded', () => {
  assert.ok(bigFile({ path: 'web/package-lock.json', patch: '@@ -1 +1 @@\n-a\n+b\n' }));
  assert.ok(!bigFile({ path: 'package.json', patch: '@@ -1 +1 @@\n-a\n+b\n' }));
  assert.ok(bigFile({ path: 'gen.ts', patch: '+x\n'.repeat(BIG_LINES + 1) }));
  assert.ok(!bigFile({ path: 'gen.ts', patch: '+x\n'.repeat(BIG_LINES) }));
  assert.ok(!bigFile({ path: 'yarn.lock', patch: '' }));
  assert.deepEqual([sizeText(2.1 * 1024 * 1024), sizeText(340 * 1024), sizeText(12)], ['2.1 MB', '340 KB', '12 B']);
});

test('diffView: J and K move one file at a time and stop at the ends', () => {
  assert.deepEqual([stepFile(-1, 3, 1), stepFile(-1, 3, -1), stepFile(2, 3, 1), stepFile(0, 3, -1), stepFile(0, 0, 1)], [0, 2, 2, 0, -1]);
});

test('highlight: keywords, calls, strings, numbers and comments, joining back to the line', () => {
  const line = "const eta = forecast(w, 90); // reset";
  const { toks } = highlightLine(line, langOf('a.ts'));
  assert.equal(toks.map(([, s]) => s).join(''), line);
  assert.deepEqual(toks.filter(([k]) => k), [['kw', 'const'], ['fn', 'forecast'], ['num', '90'], ['com', '// reset']]);
  assert.deepEqual(highlightLine("return `<div class=\"uw\">`;", 'c').toks.filter(([k]) => k), [['kw', 'return'], ['str', '`<div class="uw">`']]);
});

test('highlight: a block comment carries over to the next line, and a hash starts a comment in Python', () => {
  const a = highlightLine('x = 1; /* start', 'c');
  assert.equal(a.state.block, true);
  const b = highlightLine('still */ y', 'c', a.state);
  assert.deepEqual(b.toks[0], ['com', 'still */']);
  assert.equal(b.state.block, false);
  assert.deepEqual(highlightLine('def f(): # note', langOf('x.py')).toks.filter(([k]) => k), [['kw', 'def'], ['fn', 'f'], ['com', '# note']]);
  assert.deepEqual(highlightLine('const a = 1', langOf('README.md')).toks, [['', 'const a = 1']]);
  assert.deepEqual(highlightLine('v2 = x2', 'c').toks, [['', 'v2 = x2']]);
});

test('diffView: a no-newline note is a header row without numbers, across both sides', () => {
  const lines = numberedLines(['@@ -1,2 +1,2 @@', '-a', '+b', ' x', '\\ No newline at end of file', ''].join('\n'));
  assert.deepEqual(lines.map((l) => [l.kind, l.old, l.new]), [['h', null, null], ['del', 1, null], ['add', null, 1], ['ctx', 2, 2], ['h', null, null]]);
  const rows = splitRows(lines);
  assert.deepEqual(rows.map((r) => ('h' in r ? 'h' : `${r.left?.text ?? '-'}|${r.right?.text ?? '-'}`)), ['h', 'a|b', 'x|x', 'h']);
});

test('highlight: in a diff a removed comment opener colours only the old side, and each hunk starts over', () => {
  const kinds = (toks: [string, string][]) => toks.filter(([, s]) => s.trim()).map(([k]) => k);
  const hl = highlightDiff(numberedLines(['@@ -1,2 +1,2 @@', '-/* old', '+let a = 1;', '-still */', '@@ -9 +9 @@', '-/* open', '@@ -20 +20 @@', ' x = 2', ''].join('\n')), 'c');
  assert.deepEqual(kinds(hl[2]).slice(0, 1), ['kw'], 'the added line is code');
  assert.deepEqual(kinds(hl[3]), ['com'], 'the old side is still in its comment');
  assert.ok(!kinds(hl[7]).includes('com'), 'the next hunk is not a comment');
});
