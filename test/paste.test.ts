import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planPaste, pastedImageName, PASTE_IMAGE_MAX } from '../src/shared/paste';
import { savePastedImage } from '../src/main/attachments';

test('planPaste: copied files attach by path, like a drop, even with their names as text', () => {
  const files = [{ path: 'C:\\w\\a.md', type: 'text/markdown' }, { path: 'C:\\w\\b.png', type: 'image/png' }, { path: 'C:\\w\\a.md', type: '' }];
  assert.deepEqual(planPaste(files, false), { kind: 'paths', paths: ['C:\\w\\a.md', 'C:\\w\\b.png'] });
  assert.deepEqual(planPaste(files, true), { kind: 'paths', paths: ['C:\\w\\a.md', 'C:\\w\\b.png'] });
});

test('planPaste: a bare screenshot is saved; text with an image of itself, or other data, pastes as text', () => {
  assert.deepEqual(planPaste([{ path: '', type: 'image/png' }], false), { kind: 'images', files: [0] });
  assert.deepEqual(planPaste([{ path: '', type: 'text/html' }, { path: '', type: 'image/jpeg' }], false), { kind: 'images', files: [1] });
  assert.deepEqual(planPaste([{ path: '', type: 'image/png' }], true), { kind: 'text' });
  assert.deepEqual(planPaste([{ path: '', type: 'application/pdf' }], false), { kind: 'text' });
  assert.deepEqual(planPaste([], false), { kind: 'text' });
  assert.deepEqual(planPaste([{ path: '', type: 'image/png', size: PASTE_IMAGE_MAX + 1 }], false), { kind: 'text' });
});

test('pastedImageName: a dated name with the type\'s extension; unknown types are refused', () => {
  const at = new Date(2026, 10, 22, 9, 5, 7);
  assert.equal(pastedImageName('image/png', at, 'ab-cd/ef12345'), 'pasted-20261122-090507-abcdef12.png');
  assert.equal(pastedImageName('image/jpeg', at, 'x'), 'pasted-20261122-090507-x.jpg');
  assert.equal(pastedImageName('image/svg+xml', at, 'x'), null);
});

test('savePastedImage writes the bytes under the folder and refuses empty, oversized or unknown data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-paste-'));
  try {
    const sub = path.join(dir, 'pasted');
    const file = savePastedImage(sub, 'image/png', new Uint8Array([137, 80, 78, 71]));
    assert.equal(path.dirname(file), sub);
    assert.match(path.basename(file), /^pasted-\d{8}-\d{6}-[a-z0-9]{8}\.png$/);
    assert.deepEqual([...fs.readFileSync(file)], [137, 80, 78, 71]);
    assert.throws(() => savePastedImage(sub, 'image/png', new Uint8Array()));
    assert.throws(() => savePastedImage(sub, 'image/png', new Uint8Array(PASTE_IMAGE_MAX + 1)));
    assert.throws(() => savePastedImage(sub, 'application/x-msdownload', new Uint8Array([1])));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
