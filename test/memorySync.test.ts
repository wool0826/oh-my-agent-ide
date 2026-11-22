import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { commitAll, syncRepo } from '../src/main/memorySync';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'oma-memsync-'));
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A bare repository standing in for the remote. */
function remote() {
  const dir = tmp();
  git(dir, 'init', '-q', '--bare');
  return dir;
}

/** A memory folder as initMemory leaves it: its own root commit with preferences.md. */
function device(branch: string, line: string) {
  const dir = tmp();
  git(dir, 'init', '-q', '-b', branch);
  fs.writeFileSync(path.join(dir, 'preferences.md'), `# Preferences\n\n- ${line}\n`);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'Start memory');
  return dir;
}

const prefs = (dir: string) => fs.readFileSync(path.join(dir, 'preferences.md'), 'utf8');
const add = async (dir: string, line: string) => {
  fs.appendFileSync(path.join(dir, 'preferences.md'), `- ${line}\n`);
  await commitAll(dir, `preference: ${line}`);
};

test('an empty remote takes everything, and a second sync has nothing to do', async () => {
  const r = remote();
  const a = device('master', 'from A');
  const first = await syncRepo(a, r);
  assert.equal(first.ok, true, first.error ?? '');
  assert.equal(first.pulled, 0);
  assert.ok(first.pushed >= 1);
  assert.equal(git(r, 'rev-parse', 'refs/heads/master'), git(a, 'rev-parse', 'HEAD'));
  const again = await syncRepo(a, r);
  assert.deepEqual({ ok: again.ok, pulled: again.pulled, pushed: again.pushed, pending: again.pending }, { ok: true, pulled: 0, pushed: 0, pending: 0 });
});

test('a second PC with its own history merges with the remote and keeps the lines of both', async () => {
  const r = remote();
  const a = device('master', 'from A');
  await syncRepo(a, r);
  // B was started on its own: a root commit unrelated to the remote's, with the same file. A push alone is rejected for good.
  const b = device('master', 'from B');
  const res = await syncRepo(b, r);
  assert.equal(res.ok, true, res.error ?? '');
  assert.ok(res.pulled >= 1);
  assert.match(prefs(b), /from A/);
  assert.match(prefs(b), /from B/);
  assert.doesNotMatch(prefs(b), /<<<<<<<|>>>>>>>/);
  // A then receives B's line.
  const back = await syncRepo(a, r);
  assert.equal(back.ok, true, back.error ?? '');
  assert.match(prefs(a), /from B/);
});

test('both sides append to the same file between syncs, and neither line is lost', async () => {
  const r = remote();
  const a = device('master', 'base');
  await syncRepo(a, r);
  const b = tmp();
  git(b, 'clone', '-q', r, '.');
  await add(a, 'added on A');
  await add(b, 'added on B');
  assert.equal((await syncRepo(a, r)).ok, true);
  const res = await syncRepo(b, r);
  assert.equal(res.ok, true, res.error ?? '');
  assert.match(prefs(b), /added on A/);
  assert.match(prefs(b), /added on B/);
  assert.doesNotMatch(prefs(b), /<<<<<<</);
});

test("a remote whose branch has another name is synced on the remote's branch", async () => {
  const r = remote();
  const seed = device('main', 'from the remote');
  git(seed, 'push', '-q', r, 'main');
  const a = device('master', 'from A');
  const res = await syncRepo(a, r);
  assert.equal(res.ok, true, res.error ?? '');
  assert.match(prefs(a), /from the remote/);
  assert.equal(git(r, 'rev-parse', 'refs/heads/main'), git(a, 'rev-parse', 'HEAD'));
  assert.throws(() => git(r, 'rev-parse', '--verify', '-q', 'refs/heads/master'));
});

test('a remote that cannot be reached reports the error and how many commits wait', async () => {
  const a = device('master', 'from A');
  const res = await syncRepo(a, path.join(tmp(), 'missing.git'));
  assert.equal(res.ok, false);
  assert.ok(res.error);
  assert.ok(res.pending >= 1);
  // Nothing is lost: once the remote exists, the same commits go out.
  const r = remote();
  const later = await syncRepo(a, r);
  assert.equal(later.ok, true, later.error ?? '');
  assert.ok(later.pushed >= 1);
});

test('commitAll commits only when something changed', async () => {
  const a = device('master', 'from A');
  assert.equal(await commitAll(a, 'nothing'), false);
  fs.appendFileSync(path.join(a, 'preferences.md'), '- more\n');
  assert.equal(await commitAll(a, 'more'), true);
  assert.equal(git(a, 'status', '--porcelain'), '');
});
