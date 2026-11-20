import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { worktreeDiff } from '../src/main/gitdiff';

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' });
}

/** origin (bare) with one commit on main, and a clone on a feature branch. */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-diff-'));
  const origin = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'init', '-q', '-b', 'main', seed);
  fs.writeFileSync(path.join(seed, 'a.js'), 'one\ntwo\nthree\n');
  fs.writeFileSync(path.join(seed, 'gone.txt'), 'bye\n');
  fs.writeFileSync(path.join(seed, 'old-name.txt'), 'same content in a file that moves\n'.repeat(5));
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'init');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', 'origin', 'main');
  const wt = path.join(root, 'wt');
  git(root, 'clone', '-q', origin, wt);
  git(wt, 'switch', '-q', '-c', 'agent/t-1');
  return { root, wt };
}

test('diff: no changes on a fresh branch', async () => {
  const { root, wt } = fixture();
  try {
    const v = await worktreeDiff('main', wt);
    assert.equal(v.branch, 'agent/t-1');
    assert.equal(v.base, 'main');
    assert.deepEqual(v.files, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('diff: committed, uncommitted, deleted, renamed and untracked files', async () => {
  const { root, wt } = fixture();
  try {
    fs.writeFileSync(path.join(wt, 'a.js'), 'one\nTWO\nthree\nfour\n');
    git(wt, 'commit', '-q', '-am', 'edit a');
    fs.appendFileSync(path.join(wt, 'a.js'), 'five\n');
    git(wt, 'rm', '-q', 'gone.txt');
    git(wt, 'mv', 'old-name.txt', 'new-name.txt');
    fs.writeFileSync(path.join(wt, 'fresh.md'), '# hi\nthere\n');
    const v = await worktreeDiff('main', wt);
    const by = Object.fromEntries(v.files.map((f) => [f.path, f]));
    assert.deepEqual(Object.keys(by).sort(), ['a.js', 'fresh.md', 'gone.txt', 'new-name.txt']);
    assert.equal(by['a.js'].status, 'M');
    assert.equal(by['a.js'].added, 3);
    assert.equal(by['a.js'].removed, 1);
    assert.match(by['a.js'].patch, /^@@ /);
    assert.match(by['a.js'].patch, /\n\+five/);
    assert.equal(by['gone.txt'].status, 'D');
    assert.equal(by['gone.txt'].removed, 1);
    assert.equal(by['new-name.txt'].status, 'R');
    assert.equal(by['fresh.md'].status, '?');
    assert.equal(by['fresh.md'].added, 2);
    assert.equal(by['fresh.md'].patch, '@@ -0,0 +1,2 @@\n+# hi\n+there');
    assert.equal(v.truncated, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('diff: a folder that is not a worktree reports missing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-diff-'));
  try {
    const v = await worktreeDiff('main', dir);
    assert.equal(v.error, 'missing');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
