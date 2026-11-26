import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CHAIN, STATE_VERSION, migrate, preMigrationName, stateVersion, type MigrationChain } from '../src/shared/migrate';
import { flushNow, store } from '../src/main/store';
import { ensureHome, paths } from '../src/main/paths';

// The IDE home lives in a temp folder.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-migrate-'));
process.env.OMA_DATA_DIR = tmp;
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ home: path.join(tmp, 'home'), language: 'en' }));

const fixture = (name: string) => fs.readFileSync(path.join('test', 'fixtures', 'state', name), 'utf8');
const V1 = fixture('v1.json');
const V2 = fixture('v2/state.json');
const NEWER = fixture('v3-newer.json');

/** A chain one version past this build's: version 2 → 3 gives every Worker a `pinned` flag. */
const toV3: MigrationChain = {
  version: 3,
  steps: { ...CHAIN.steps, 2: (s) => { for (const w of s.workers as Record<string, unknown>[]) w.pinned = false; } },
};
/** One more step that throws half way through its work. */
const toV4Broken: MigrationChain = {
  version: 4,
  steps: { ...toV3.steps, 3: (s) => { s.chat = []; throw new Error('step 3 broke'); } },
};

function setUp(text: string) {
  ensureHome();
  for (const f of fs.readdirSync(paths().data)) if (/^(state|chat|tasks-done)/.test(f)) fs.rmSync(path.join(paths().data, f), { force: true });
  fs.writeFileSync(paths().state, text);
}
const copies = () => fs.readdirSync(paths().data).filter((f) => /^state-v\d+-before-v\d+-\d+\.json$/.test(f));
const onDisk = () => fs.readFileSync(paths().state, 'utf8');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('migrate: the chain this build ships ends at the version it writes', () => {
  assert.equal(CHAIN.version, STATE_VERSION);
  assert.deepEqual(migrate(JSON.parse(V2)), { kind: 'current', state: JSON.parse(V2) });
  assert.deepEqual(migrate(JSON.parse(V1)), { kind: 'migrated', state: { ...JSON.parse(V1), version: 2 }, from: 1, to: 2 });
});

test('migrate: a version a step at a time, without changing the state passed in', () => {
  const chain: MigrationChain = {
    version: 3,
    steps: {
      1: (s) => ({ ...s, a: 1 }),
      2: (s) => { s.b = (s.a as number) + 1; },
    },
  };
  const old = { version: 1, keep: { x: 1 } };
  const r = migrate(old, chain);
  assert.deepEqual(r, { kind: 'migrated', state: { version: 3, keep: { x: 1 }, a: 1, b: 2 }, from: 1, to: 3 });
  assert.deepEqual(old, { version: 1, keep: { x: 1 } });
});

test('migrate: a step that throws or is missing fails, naming where, and the state is untouched', () => {
  const old = JSON.parse(V1);
  const r = migrate(old, toV4Broken);
  assert.deepEqual(r, { kind: 'failed', from: 1, at: 3, error: 'step 3 broke' });
  assert.deepEqual(old, JSON.parse(V1), 'the half-done step changed only its copy');
  assert.deepEqual(migrate({ version: 1 }, { version: 3, steps: { 1: () => {} } }),
    { kind: 'failed', from: 1, at: 2, error: 'no step from version 2 to 3' });
  assert.deepEqual(migrate({ version: 1 }, { version: 2, steps: { 1: () => [] as unknown as Record<string, unknown> } }),
    { kind: 'failed', from: 1, at: 1, error: 'the step returned no state' });
});

test('migrate: a newer state is never brought down; one without a version counts as the first', () => {
  assert.deepEqual(migrate({ version: 3 }, CHAIN), { kind: 'newer', version: 3 });
  assert.equal(stateVersion({}), 1);
  assert.equal(stateVersion({ version: 'two' }), 1);
  assert.equal(stateVersion({ version: 0 }), 1);
  assert.equal(preMigrationName(1, 2, 42), 'state-v1-before-v2-42.json');
});

test('store: an old state file migrates on load, after a copy of it is kept', () => {
  setUp(V1);
  store.load(toV3);
  assert.equal(store.readOnly, null);
  assert.equal(store.migrated?.from, 1);
  assert.equal(store.data.version, 3);
  assert.deepEqual(store.data.workers.map((w) => (w as unknown as { pinned: boolean }).pinned), [false]);
  assert.deepEqual(store.data.chat.map((c) => c.id), ['c1', 'c2'], 'nothing else moved');
  // The copy holds the file as it was; the file holds the new version.
  assert.equal(copies().length, 1);
  assert.equal(path.join(paths().data, copies()[0]), store.migrated?.copy);
  assert.equal(fs.readFileSync(store.migrated!.copy, 'utf8'), V1);
  assert.equal(JSON.parse(onDisk()).version, 3);
  // The next start finds nothing to do and keeps no further copy.
  store.load(toV3);
  assert.equal(store.migrated, null);
  assert.equal(copies().length, 1);
});

test('store: a step that throws puts the copy back and opens the state read-only', async () => {
  setUp(V1);
  store.load(toV4Broken);
  assert.deepEqual(store.readOnly, { why: 'failed', from: 1, error: 'step 3 broke' });
  assert.equal(store.migrated, null);
  assert.equal(store.data.version, 1);
  assert.deepEqual(store.data.chat.map((c) => c.id), ['c1', 'c2'], 'the state as it was, not the half-done step');
  assert.equal(copies().length, 1);
  assert.equal(onDisk(), V1);
  // Nothing done while it is read-only reaches the file.
  store.chat('event', 'after the failure');
  assert.equal(flushNow(), false);
  await wait(400);
  assert.equal(onDisk(), V1);
});

test('store: a state file a newer build saved is left alone and opened read-only', async () => {
  setUp(NEWER);
  store.load();
  assert.deepEqual(store.readOnly, { why: 'newer', version: 3 });
  assert.equal(store.data.counters.task, 9);
  assert.deepEqual(copies(), [], 'no copy: nothing is migrated');
  store.nextTaskId();
  store.chat('event', 'read only');
  assert.equal(flushNow(), false);
  await wait(400);
  assert.equal(onDisk(), NEWER);
});

test('store: an unreadable file goes back to a backup, which then migrates; the unreadable file is set aside', () => {
  setUp('{ not json');
  fs.mkdirSync(paths().backups, { recursive: true });
  for (const f of fs.readdirSync(paths().backups)) fs.rmSync(path.join(paths().backups, f));
  fs.writeFileSync(path.join(paths().backups, 'state-2026-11-20.json'), V1);
  store.load(toV3);
  assert.equal(store.restoredFrom, '2026-11-20');
  assert.equal(store.readOnly, null);
  assert.equal(store.migrated?.from, 1);
  assert.equal(fs.readFileSync(store.migrated!.copy, 'utf8'), V1);
  assert.equal(JSON.parse(onDisk()).version, 3);
  assert.equal(fs.readdirSync(paths().data).filter((f) => f.startsWith('state-broken-')).length, 1);
  // A backup whose step fails: the unreadable file stays as it was, read-only.
  setUp('{ not json');
  store.load(toV4Broken);
  assert.deepEqual(store.readOnly, { why: 'failed', from: 1, error: 'step 3 broke' });
  assert.equal(onDisk(), '{ not json');
  fs.rmSync(paths().backups, { recursive: true, force: true });
});

test('store: a current state file loads as before, with no copy and writable', () => {
  setUp(V2);
  store.load();
  assert.equal(store.readOnly, null);
  assert.equal(store.migrated, null);
  assert.deepEqual(copies(), []);
  assert.equal(flushNow(), true);
  assert.equal(JSON.parse(onDisk()).version, 2);
});
