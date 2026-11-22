import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import { addingRepo, cancelAddRepo, cleanupBranch, cloneProgress, ensureWorktree, registerRepo, removeWorktree, watchClone, type CloneChild } from '../src/main/repos';
import { holdsWork, inspectBranch } from '../src/main/gitwork';
import { baseRef, pickLocalDefault } from '../src/shared/localRepo';
import { paths } from '../src/main/paths';
import { store } from '../src/main/store';

// Adding repositories, with real git in a temp folder.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-repos-'));
process.env.OMA_DATA_DIR = tmp;
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ home: path.join(tmp, 'home'), language: 'en', accounts: [] }));

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' });

/** A repository with one commit on main (or the branch given). */
function seed(name: string, branch = 'main') {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  git(dir, 'init', '-q', '-b', branch);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'first');
  return dir;
}

const origin = path.join(tmp, 'shop.git');
git(tmp, 'clone', '-q', '--bare', seed('shop-seed'), origin);
const leftovers = () => fs.existsSync(paths().repos) ? fs.readdirSync(paths().repos).filter((x) => x.includes('.adding-')) : [];

beforeEach(() => { store.data.repos = []; });

test('a clone goes through a temporary folder and is registered under its name once complete (M8)', async () => {
  const r = await registerRepo({ url: pathToFileURL(origin).href });
  assert.equal(r.name, 'shop');
  assert.equal(r.path, path.join(paths().repos, 'shop'));
  assert.equal(r.defaultBranch, 'main');
  assert.ok(fs.existsSync(path.join(r.path, 'a.txt')));
  assert.deepEqual(leftovers(), []);
  assert.equal(addingRepo(), null);
});

test('a failed clone leaves no folder that a later add would take for a clone (M8)', async () => {
  const url = pathToFileURL(path.join(tmp, 'missing.git')).href;
  await assert.rejects(registerRepo({ url }), /git clone failed/);
  assert.ok(!fs.existsSync(path.join(paths().repos, 'missing')));
  assert.deepEqual(leftovers(), []);
  assert.equal(addingRepo(), null);
});

test('a folder already there is used again only when it is a clone of the same URL (M8)', async () => {
  const dir = path.join(paths().repos, 'other');
  fs.mkdirSync(dir, { recursive: true });
  await assert.rejects(registerRepo({ url: pathToFileURL(path.join(tmp, 'other.git')).href }), /already exists and is not a clone/);
});

test('a local folder without a remote is registered as local only, on the branch it has checked out (T-0027)', async () => {
  const dir = seed('local-only', 'trunk');
  const r = await registerRepo({ url: dir });
  assert.deepEqual([r.name, r.path, r.url, r.defaultBranch, r.local], ['local-only', dir, dir, 'trunk', true]);
  assert.equal(baseRef(r), 'trunk');
  assert.equal(addingRepo(), null);
});

test('a plain folder and a repository with no commit are refused with what to do (T-0027)', async () => {
  const plain = path.join(tmp, 'plain');
  fs.mkdirSync(plain);
  // Not inside any repository: the temp folder is not one.
  await assert.rejects(registerRepo({ url: plain }), /git init and make a first commit/);
  const empty = path.join(tmp, 'empty');
  fs.mkdirSync(empty);
  git(empty, 'init', '-q', '-b', 'main');
  await assert.rejects(registerRepo({ url: empty }), /no commits yet/);
  assert.equal(store.data.repos.length, 0);
  assert.equal(addingRepo(), null);
});

test('the default branch of a local repository: checked out, then init.defaultBranch, then main or master, then any', () => {
  assert.equal(pickLocalDefault('dev', 'main', ['dev', 'main']), 'dev');
  assert.equal(pickLocalDefault('', 'trunk', ['main', 'trunk']), 'trunk');
  assert.equal(pickLocalDefault('gone', '', ['master', 'x']), 'master');
  assert.equal(pickLocalDefault('', '', ['x']), 'x');
  assert.equal(pickLocalDefault('main', 'main', []), null);
});

test('a Worker worktree of a local-only repository starts from its local branch; one with origin from origin (T-0027)', async () => {
  const dir = seed('wt-local', 'trunk');
  const r = await registerRepo({ url: dir, name: 'wt-local' });
  const wt = await ensureWorktree(r, 'W-1');
  assert.equal(git(wt, 'rev-parse', 'HEAD').trim(), git(dir, 'rev-parse', 'trunk').trim());
  // A commit on a task branch is work: inspecting it against the local branch finds it, so it is kept.
  git(wt, 'switch', '-q', '-c', 'agent/t-1');
  fs.writeFileSync(path.join(wt, 'b.txt'), 'b\n');
  git(wt, 'add', '.');
  git(wt, 'commit', '-q', '-m', 'work');
  const b = await inspectBranch(dir, wt, r.defaultBranch, 'agent/t-1', true);
  assert.deepEqual([b.local, b.remote, b.commits, holdsWork(b)], [true, false, 1, true]);
  // Nothing remote is touched, and removing the worktree keeps the branch with its commit.
  await cleanupBranch(r, wt, 'agent/t-1');
  await removeWorktree(r, wt);
  assert.ok(!fs.existsSync(wt));
  assert.match(git(dir, 'branch', '--list', 'agent/t-1'), /agent\/t-1/);

  const clone = path.join(tmp, 'wt-remote');
  git(tmp, 'clone', '-q', origin, clone);
  const rr = await registerRepo({ url: clone, name: 'wt-remote' });
  assert.equal(rr.local, undefined);
  assert.equal(baseRef(rr), 'origin/main');
  const wt2 = await ensureWorktree(rr, 'W-1');
  assert.equal(git(wt2, 'rev-parse', 'HEAD').trim(), git(clone, 'rev-parse', 'origin/main').trim());
});

/** A stand-in for the git clone process: the test says when it prints, exits and closes. */
function fakeChild() {
  const p = new EventEmitter() as EventEmitter & CloneChild & { killed: number };
  p.stderr = new EventEmitter();
  p.killed = 0;
  p.kill = () => { p.killed++; p.emit('exit', null); p.emit('close', null); return true; };
  return p;
}
const watch = (p: CloneChild, over: Partial<Parameters<typeof watchClone>[1]> = {}) =>
  watchClone(p, { stallMs: 50, totalMs: 5000, cancelled: () => false, progress: () => {}, kill: (c) => { c.kill(); }, ...over });

test('a clone that prints nothing is stopped after the stall time, with a reason (T-0027)', async () => {
  const p = fakeChild();
  await assert.rejects(watch(p), /made no progress/);
  assert.equal(p.killed, 1);
});

test('a clone that keeps printing is not stopped, and its progress lines are passed on', async () => {
  const p = fakeChild();
  const lines: string[] = [];
  const done = watch(p, { progress: (l) => lines.push(l) });
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 30));
    p.stderr!.emit('data', Buffer.from(`Receiving objects:  ${i}0% (${i}/10)\r`));
  }
  p.emit('exit', 0);
  p.emit('close', 0);
  await done;
  assert.equal(p.killed, 0);
  assert.equal(lines.at(-1), 'Receiving objects:  30% (3/10)');
});

test('git missing (spawn ENOENT) rejects with a readable reason instead of waiting forever', async () => {
  const p = fakeChild();
  const done = watch(p, { stallMs: 5000 });
  p.emit('error', Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }));
  await assert.rejects(done, /git was not found/);
});

test('a clone whose helper keeps stderr open settles soon after git exits', async () => {
  const p = fakeChild();
  const done = watch(p, { stallMs: 10_000 });
  p.stderr!.emit('data', Buffer.from('fatal: Authentication failed\n'));
  p.emit('exit', 128);
  // No close: a process git started still holds the pipe.
  await assert.rejects(done, /Authentication failed/);
});

test('a cancelled clone says it was cancelled', async () => {
  const p = fakeChild();
  let cancelled = false;
  const done = watch(p, { stallMs: 10_000, cancelled: () => cancelled });
  cancelled = true;
  p.kill();
  await assert.rejects(done, /cancelled/);
});

test('after a failed add, the next one can start: the busy state is always reset', async () => {
  await assert.rejects(registerRepo({ url: path.join(tmp, 'plain') }));
  assert.equal(addingRepo(), null);
  assert.equal(cancelAddRepo(), false);
  const r = await registerRepo({ url: seed('after-fail'), name: 'after-fail' });
  assert.equal(r.name, 'after-fail');
});

test('a local folder with origin is registered in place, with origin as its URL', async () => {
  const dir = path.join(tmp, 'local-clone');
  git(tmp, 'clone', '-q', origin, dir);
  const r = await registerRepo({ url: dir, name: 'local' });
  assert.deepEqual([r.name, r.path, r.url, r.defaultBranch], ['local', dir, origin, 'main']);
});

test('clone progress is the last line git printed, without "remote: "', () => {
  assert.equal(cloneProgress("Cloning into 'x'...\nremote: Counting objects:  50% (5/10)\r"), 'Counting objects:  50% (5/10)');
  assert.equal(cloneProgress('Receiving objects:  12% (12/100)\rReceiving objects:  13% (13/100)\r'), 'Receiving objects:  13% (13/100)');
  assert.equal(cloneProgress('Resolving deltas: 100% (3/3), done.\n'), 'Resolving deltas: 100% (3/3)');
  assert.equal(cloneProgress('warning: something\n'), null);
});

test('cancelling a clone stops it, removes its temporary folder and registers nothing (M8)', async () => {
  const p = registerRepo({ url: pathToFileURL(origin).href, name: 'cancelled' });
  assert.equal(addingRepo()?.name, 'cancelled');
  await assert.rejects(registerRepo({ url: pathToFileURL(origin).href, name: 'second' }), /cancelled is being added/);
  assert.ok(cancelAddRepo());
  await assert.rejects(p, /was cancelled/);
  assert.ok(!fs.existsSync(path.join(paths().repos, 'cancelled')));
  assert.deepEqual(leftovers(), []);
  assert.equal(store.data.repos.length, 0);
});
