import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TG_FILE_MAX, fileUrlPath, pickFile, safeFileName } from '../src/shared/remoteFile';

const DATE = Date.UTC(2026, 10, 28, 9, 30, 5) / 1000;

test('remoteFile: a name keeps its last path part only, without characters a file system refuses', () => {
  assert.equal(safeFileName('../../etc/passwd', 'file'), 'passwd');
  assert.equal(safeFileName('C:\\Users\\me\\notes.txt', 'file'), 'notes.txt');
  assert.equal(safeFileName('a<b>:c"|?*.md', 'file'), 'abc.md');
  assert.equal(safeFileName('report.txt:hidden', 'file'), 'report.txthidden');
  assert.equal(safeFileName('line\nbreak\u0007.txt', 'file'), 'linebreak.txt');
});

test('remoteFile: an empty, dotted or device name becomes a safe one', () => {
  assert.equal(safeFileName(undefined, 'file'), 'file');
  assert.equal(safeFileName('...', 'file'), 'file');
  assert.equal(safeFileName('.env', 'file'), 'env');
  assert.equal(safeFileName('notes. ', 'file'), 'notes');
  assert.equal(safeFileName('CON.txt', 'file'), '_CON.txt');
  assert.equal(safeFileName('lpt1', 'file'), '_lpt1');
});

test('remoteFile: a long name is cut to 100 characters and keeps its extension', () => {
  const name = safeFileName(`${'a'.repeat(300)}.pdf`, 'file');
  assert.equal(name.length, 100);
  assert.ok(name.endsWith('.pdf'));
});

test('remoteFile: a photo is taken at its largest size, named by when it was sent', () => {
  const p = pickFile({ date: DATE, photo: [{ file_id: 'big', width: 1280, height: 853, file_size: 90_000 }, { file_id: 'small', width: 90, height: 60, file_size: 900 }] });
  assert.deepEqual(p, { kind: 'file', file: { fileId: 'big', name: 'photo-20261128-093005.jpg', size: 90_000 } });
});

test('remoteFile: a size past the download limit is left for a smaller one, or refused', () => {
  const p = pickFile({ date: DATE, photo: [{ file_id: 'mid', width: 800, height: 600, file_size: 1_000 }, { file_id: 'huge', width: 9000, height: 9000, file_size: TG_FILE_MAX + 1 }] });
  assert.equal(p?.kind === 'file' && p.file.fileId, 'mid');
  assert.deepEqual(pickFile({ date: DATE, document: { file_id: 'd', file_name: 'big.zip', file_size: TG_FILE_MAX + 1 } }), { kind: 'tooBig' });
});

test('remoteFile: a document keeps its safe name; programs and shortcuts are refused', () => {
  assert.deepEqual(pickFile({ date: DATE, document: { file_id: 'd', file_name: 'spec.pdf', file_size: 10 } }), { kind: 'file', file: { fileId: 'd', name: 'spec.pdf', size: 10 } });
  for (const name of ['setup.exe', 'invoice.pdf.EXE', 'run.bat ', 'x.ps1.', 'Link.lnk', 'tool.app', 'disk.dmg']) {
    assert.deepEqual(pickFile({ date: DATE, document: { file_id: 'd', file_name: name } }), { kind: 'blocked' }, name);
  }
  assert.equal(pickFile({ date: DATE }), null);
});

test('remoteFile: only a plain relative path goes into a download address', () => {
  assert.equal(fileUrlPath('photos/file_12.jpg'), 'photos/file_12.jpg');
  for (const p of ['', '../x', 'a/../b', '/abs', 'a?b', 'a b', 'http://x/y']) assert.equal(fileUrlPath(p), null, p);
});
