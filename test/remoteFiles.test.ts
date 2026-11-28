import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dropRemoteFiles, saveRemoteFile } from '../src/main/remote/files';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'oma-tgfiles-'));

test('remoteFiles: each file is written in a folder of its own under the app folder, two of one name apart', () => {
  const dir = tmp();
  try {
    const a = saveRemoteFile(dir, 'notes.txt', new TextEncoder().encode('one'), new Date(Date.UTC(2026, 10, 28)));
    const b = saveRemoteFile(dir, 'notes.txt', new TextEncoder().encode('two'));
    assert.notEqual(a, b);
    assert.equal(path.basename(a), 'notes.txt');
    assert.match(path.basename(path.dirname(a)), /^20261128-[0-9a-f]{8}$/);
    assert.equal(path.dirname(path.dirname(a)), dir);
    assert.equal(fs.readFileSync(a, 'utf8'), 'one');
    assert.equal(fs.readFileSync(b, 'utf8'), 'two');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('remoteFiles: a name that leads out of its folder is refused', () => {
  const dir = tmp();
  try {
    for (const name of ['../out.txt', 'sub/inner.txt', '..']) assert.throws(() => saveRemoteFile(dir, name, new Uint8Array([1])), /bad file name/, name);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('remoteFiles: dropping removes a saved file with its folder, and nothing outside the app folder', () => {
  const dir = tmp();
  const other = tmp();
  try {
    const a = saveRemoteFile(dir, 'a.txt', new Uint8Array([1]));
    const outside = path.join(other, 'keep', 'b.txt');
    fs.mkdirSync(path.dirname(outside));
    fs.writeFileSync(outside, 'b');
    dropRemoteFiles(dir, [a, outside, path.join(dir, 'loose.txt')]);
    assert.deepEqual(fs.readdirSync(dir), []);
    assert.ok(fs.existsSync(outside));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(other, { recursive: true, force: true }); }
});
