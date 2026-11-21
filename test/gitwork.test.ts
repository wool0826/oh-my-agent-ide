import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dropBranch, holdsWork, inspectBranch, worktreeClean } from '../src/main/gitwork';

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' });
}

const BRANCH = 'agent/t-1';

/** Like the app: origin (bare), the main checkout, and a Worker worktree added from it on the task branch. */
function fixture(opts: { branch?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-cancel-'));
  const origin = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'init', '-q', '-b', 'main', seed);
  fs.writeFileSync(path.join(seed, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(seed, '.gitignore'), '.env\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'init');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', 'origin', 'main');
  const repo = path.join(root, 'repo');
  git(root, 'clone', '-q', origin, repo);
  const wt = path.join(root, 'wt');
  git(repo, 'worktree', 'add', '-q', '--detach', wt, 'origin/main');
  if (opts.branch !== false) git(wt, 'switch', '-q', '-c', BRANCH, 'origin/main');
  return { root, origin, repo, wt };
}

const branches = (cwd: string) => git(cwd, 'branch', '--list', '--format=%(refname:short)').split('\n').filter(Boolean);
const remoteHas = (origin: string, b: string) => git(origin, 'branch', '--list', b).trim() !== '';

test('cancel: a task that never started has no branch to clean up', async () => {
  const { root, repo, wt } = fixture({ branch: false });
  try {
    const b = await inspectBranch(repo, wt, 'main', BRANCH);
    assert.deepEqual(b, { local: false, remote: false, commits: 0, checkedOut: false, dirty: false });
    assert.equal(holdsWork(b), false);
    await dropBranch(repo, wt, 'main', BRANCH, b);
    assert.deepEqual(branches(repo), ['main']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('cancel: an empty task branch is deleted and the worktree goes back to the default branch', async () => {
  const { root, repo, wt } = fixture();
  try {
    fs.writeFileSync(path.join(wt, '.env'), 'SECRET=1\n'); // ignored files (setup copies) are not work
    const b = await inspectBranch(repo, wt, 'main', BRANCH);
    assert.deepEqual(b, { local: true, remote: false, commits: 0, checkedOut: true, dirty: false });
    await dropBranch(repo, wt, 'main', BRANCH, b);
    assert.deepEqual(branches(repo), ['main']);
    assert.equal(git(wt, 'branch', '--show-current').trim(), '');
    assert.equal(git(wt, 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'origin/main'));
    assert.equal(await worktreeClean(wt), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('cancel: a pushed branch without new commits is deleted on the remote too', async () => {
  const { root, origin, repo, wt } = fixture();
  try {
    git(wt, 'push', '-q', '-u', 'origin', BRANCH);
    assert.equal(remoteHas(origin, BRANCH), true);
    const b = await inspectBranch(repo, wt, 'main', BRANCH);
    assert.equal(b.remote, true);
    assert.equal(holdsWork(b), false);
    await dropBranch(repo, wt, 'main', BRANCH, b);
    assert.equal(remoteHas(origin, BRANCH), false);
    assert.deepEqual(branches(repo), ['main']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('cancel: a branch with commits is kept', async () => {
  const { root, repo, wt } = fixture();
  try {
    fs.writeFileSync(path.join(wt, 'a.txt'), 'two\n');
    git(wt, 'commit', '-q', '-am', 'work');
    const b = await inspectBranch(repo, wt, 'main', BRANCH);
    assert.equal(b.commits, 1);
    assert.equal(b.dirty, false);
    assert.equal(holdsWork(b), true);
    await assert.rejects(dropBranch(repo, wt, 'main', BRANCH, b));
    assert.deepEqual(branches(repo).sort(), [BRANCH, 'main']);
    assert.equal(git(wt, 'branch', '--show-current').trim(), BRANCH);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('cancel: commits that exist only on the pushed branch count too', async () => {
  const { root, repo, wt } = fixture();
  try {
    fs.writeFileSync(path.join(wt, 'a.txt'), 'two\n');
    git(wt, 'commit', '-q', '-am', 'work');
    git(wt, 'push', '-q', '-u', 'origin', BRANCH);
    git(wt, 'reset', '-q', '--hard', 'origin/main');
    const b = await inspectBranch(repo, wt, 'main', BRANCH);
    assert.equal(b.local && b.remote, true);
    assert.equal(b.commits, 1);
    assert.equal(holdsWork(b), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('cancel: uncommitted changes on the task branch are kept, tracked or new', async () => {
  const { root, repo, wt } = fixture();
  try {
    fs.writeFileSync(path.join(wt, 'new.txt'), 'draft\n');
    let b = await inspectBranch(repo, wt, 'main', BRANCH);
    assert.equal(b.dirty, true);
    assert.equal(holdsWork(b), true);
    assert.equal(await worktreeClean(wt), false);
    fs.rmSync(path.join(wt, 'new.txt'));
    fs.writeFileSync(path.join(wt, 'a.txt'), 'edited\n');
    b = await inspectBranch(repo, wt, 'main', BRANCH);
    assert.equal(b.dirty, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('cancel: changes in a worktree that is on another branch do not belong to the cancelled task', async () => {
  const { root, repo, wt } = fixture();
  try {
    git(wt, 'switch', '-q', '-c', 'agent/t-2', 'origin/main');
    fs.writeFileSync(path.join(wt, 'other.txt'), 'other task\n');
    const b = await inspectBranch(repo, wt, 'main', BRANCH);
    assert.deepEqual(b, { local: true, remote: false, commits: 0, checkedOut: false, dirty: false });
    await dropBranch(repo, wt, 'main', BRANCH, b);
    assert.deepEqual(branches(repo).sort(), ['agent/t-2', 'main']);
    // The other task's worktree is left exactly as it was.
    assert.equal(git(wt, 'branch', '--show-current').trim(), 'agent/t-2');
    assert.equal(fs.existsSync(path.join(wt, 'other.txt')), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
