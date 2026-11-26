import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyBlockers, feedOverride, isNewer, mayApply, parseVersion, releaseUrl, updateFrom, type UpdateState } from '../src/shared/update';
import * as main from '../src/main/update';

test('versions compare by number, not by text', () => {
  assert.equal(isNewer('v0.10.0', '0.9.9'), true);
  assert.equal(isNewer('0.4.1', '0.4.0'), true);
  assert.equal(isNewer('0.4.0', '0.4.0'), false);
  assert.equal(isNewer('0.3.9', '0.4.0'), false);
  assert.equal(isNewer('1.0.0-beta', '0.4.0'), false);
  assert.deepEqual(parseVersion(' v1.2.3 '), [1, 2, 3]);
});

test('an update is offered only for a newer, published release on GitHub', () => {
  const rel = { tag_name: 'v0.5.0', html_url: 'https://github.com/wool0826/oh-my-agent-ide/releases/tag/v0.5.0' };
  assert.deepEqual(updateFrom(rel, '0.4.0'), { version: '0.5.0', url: rel.html_url });
  assert.equal(updateFrom(rel, '0.5.0'), null);
  assert.equal(updateFrom({ ...rel, draft: true }, '0.4.0'), null);
  assert.equal(updateFrom({ ...rel, prerelease: true }, '0.4.0'), null);
  assert.equal(updateFrom({ ...rel, html_url: 'https://example.com/x' }, '0.4.0'), null);
  assert.equal(updateFrom({ message: 'Not Found' }, '0.4.0'), null);
  assert.equal(updateFrom(null, '0.4.0'), null);
});

test('a restart into the update waits for every Worker turn, every queued task and the Dispatcher', () => {
  const w = (status: string) => ({ status });
  const none = { workers: 0, queued: 0, dispatcher: false };
  assert.deepEqual(applyBlockers({ workers: [], tasks: [], dispatcherBusy: false }), none);
  assert.deepEqual(
    applyBlockers({ workers: ['starting', 'running', 'waiting', 'idle', 'error', 'archived'].map(w), tasks: ['queued', 'queued', 'blocked', 'running', 'pr_open', 'done'].map(w), dispatcherBusy: true }),
    { workers: 3, queued: 2, dispatcher: true },
  );
  // [state, blockers, may apply]
  const rows: [UpdateState, typeof none, boolean][] = [
    ['ready', none, true],
    ['ready', { ...none, workers: 1 }, false],
    ['ready', { ...none, queued: 1 }, false],
    ['ready', { ...none, dispatcher: true }, false],
    ['downloading', none, false],
    ['checking', none, false],
    ['failed', none, false],
    ['link', none, false],
    ['idle', none, false],
  ];
  for (const [state, b, ok] of rows) assert.equal(mayApply(state, b), ok, `${state} ${JSON.stringify(b)}`);
});

test('versions: plain three numbers only, compared number by number', () => {
  assert.equal(isNewer('0.7.0', '0.6.2'), true);
  assert.equal(isNewer('1.0.0', '0.99.99'), true);
  assert.equal(isNewer('0.6.10', '0.6.9'), true);
  assert.equal(isNewer('0.6.2', '0.7.0'), false);
  assert.equal(isNewer('0.7.0-rc.1', '0.6.2'), false);
  assert.equal(isNewer('0.7', '0.6.2'), false);
  assert.deepEqual(parseVersion('v0.7.0'), [0, 7, 0]);
  assert.equal(releaseUrl('0.7.0'), 'https://github.com/wool0826/oh-my-agent-ide/releases/tag/v0.7.0');
});

test('a test feed is taken only from this computer', () => {
  assert.equal(feedOverride('http://127.0.0.1:8765'), 'http://127.0.0.1:8765/');
  assert.equal(feedOverride(' http://localhost:9000/feed/ '), 'http://localhost:9000/feed/');
  assert.equal(feedOverride('http://[::1]:8765/'), 'http://[::1]:8765/');
  assert.equal(feedOverride('https://example.com/'), null);
  assert.equal(feedOverride('http://127.0.0.1.example.com/'), null);
  assert.equal(feedOverride('file:///C:/feed/'), null);
  assert.equal(feedOverride('not a url'), null);
  assert.equal(feedOverride(''), null);
  assert.equal(feedOverride(undefined), null);
});

test('fake mode never reaches the network, and a fake ready update restarts only when nothing works', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-upd-'));
  const saved = { fake: process.env.OMA_FAKE_AGENT, data: process.env.OMA_DATA_DIR, upd: process.env.OMA_FAKE_UPDATE, fetch: globalThis.fetch };
  process.env.OMA_FAKE_AGENT = '1';
  process.env.OMA_DATA_DIR = dir;
  let fetched = 0;
  globalThis.fetch = (async () => { fetched++; throw new Error('no network in fake mode'); }) as typeof fetch;
  try {
    await main.checkUpdate();
    delete process.env.OMA_FAKE_UPDATE;
    main.startUpdateCheck({ changed: () => {}, found: () => {} });
    assert.equal(main.readyVersion(), null);
    const none = { workers: 0, queued: 0, dispatcher: false };
    assert.equal(main.applyUpdate(none), false);
    process.env.OMA_FAKE_UPDATE = '9.9.9';
    const found: string[] = [];
    main.startUpdateCheck({ changed: () => {}, found: (v, ready) => found.push(`${v}:${ready}`) });
    assert.deepEqual(found, ['9.9.9:true']);
    assert.equal(main.readyVersion(), '9.9.9');
    assert.deepEqual(main.updateView({ ...none, workers: 2 }), { state: 'ready', version: '9.9.9', url: releaseUrl('9.9.9'), percent: 100, blockers: { ...none, workers: 2 } });
    assert.equal(main.applyUpdate({ ...none, workers: 2 }), false);
    assert.equal(main.applyUpdate(none), true);
    assert.equal(main.restartIntoUpdate(none), false);
    await main.checkUpdate();
    assert.equal(fetched, 0);
  } finally {
    globalThis.fetch = saved.fetch;
    for (const [k, v] of [['OMA_FAKE_AGENT', saved.fake], ['OMA_DATA_DIR', saved.data], ['OMA_FAKE_UPDATE', saved.upd]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});
