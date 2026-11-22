import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { addingRepo, cancelAddRepo, cloneProgress, registerRepo } from '../src/main/repos';
import { paths } from '../src/main/paths';
import { store } from '../src/main/store';

// Adding repositories, with real git in a temp folder.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-repos-'));
process.env.OMA_DATA_DIR = tmp;
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ home: path.join(tmp, 'home'), language: 'en', accounts: [] }));

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' });

/** A repository with one commit on main. */
function seed(name: string) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
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

test('a local folder without an origin remote is refused: no Worker could start in it (M8)', async () => {
  const dir = seed('local-only');
  await assert.rejects(registerRepo({ url: dir }), /no "origin" remote/);
  assert.equal(store.data.repos.length, 0);
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
