import { test } from 'node:test';
import assert from 'node:assert/strict';
import { patchLines, reviewMessage, type DiffNote } from '../src/shared/diffComment';

const patch = ['@@ -10,4 +10,5 @@ function a() {', ' const x = 1;', '-const y = 2;', '+const y = 3;', '+const z = 4;', ' return x;', '\\ No newline at end of file', ''].join('\n');

test('lines carry the number they have in the file', () => {
  const ls = patchLines(patch);
  assert.deepEqual(ls.map((l) => [l.kind, l.no]), [['h', null], ['ctx', 10], ['del', 11], ['add', 11], ['add', 12], ['ctx', 13], ['h', null]]);
  assert.equal(ls[3].text, '+const y = 3;');
});

test('a second hunk starts from its own header', () => {
  const ls = patchLines('@@ -1 +1 @@\n-a\n+b\n@@ -40,2 +40,2 @@\n c\n-d\n+e');
  assert.deepEqual(ls.map((l) => l.no), [null, 1, 1, null, 40, 41, 41]);
});

test('the message lists each note with its file, line and code, in file and line order', () => {
  const notes: DiffNote[] = [
    { path: 'src/b.ts', at: 3, no: 11, code: '+const y = 3;', text: ' Use the constant. ' },
    { path: 'src/a.ts', at: 9, no: 40, code: '-old()', text: 'Why remove this?' },
    { path: 'src/a.ts', at: 2, no: 5, code: '+x', text: 'Rename.' },
    { path: 'src/a.ts', at: 4, no: 7, code: '+y', text: '   ' },
  ];
  assert.equal(reviewMessage(notes), '[Review comments on your changes]\n\nsrc/a.ts:5\n> +x\nRename.\n\nsrc/a.ts:40\n> -old()\nWhy remove this?\n\nsrc/b.ts:11\n> +const y = 3;\nUse the constant.');
});

test('no notes, no message; a long line is cut', () => {
  assert.equal(reviewMessage([]), '');
  const m = reviewMessage([{ path: 'a', at: 0, no: 1, code: `+${'x'.repeat(300)}`, text: 'long' }]);
  assert.ok(m.split('\n')[3].length <= 162 && m.split('\n')[3].endsWith('…'));
});
