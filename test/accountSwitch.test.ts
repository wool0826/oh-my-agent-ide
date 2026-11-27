import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { accounts } from '../src/main/accounts';

// Accounts saved before the switch existed, one off for an hour that ended while the app was closed, one off.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-switch-'));
process.env.OMA_DATA_DIR = tmp;
const past = new Date(Date.now() - 60_000).toISOString();
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({
  home: path.join(tmp, 'home'), language: 'en',
  accounts: [
    { id: 'a1', label: 'One', kind: 'login', plan: 'team' },
    { id: 'a2', label: 'Two', kind: 'login', plan: 'team', paused: true, pausedUntil: past },
    { id: 'a3', label: 'Three', kind: 'login', plan: 'team', paused: true, pausedUntil: null },
  ],
}));
const file = () => JSON.parse(fs.readFileSync(path.join(tmp, 'settings.json'), 'utf8')) as { accounts: { id: string; paused: boolean; pausedUntil: string | null }[] };

test('account switch: old accounts load as on, an ended hour as on, an account switched off stays off', () => {
  const v = accounts.views();
  assert.deepEqual(v.map((a) => [a.id, a.paused, a.pausedUntil]), [['a1', false, null], ['a2', false, null], ['a3', true, null]]);
});

test('account switch: no task is assigned to an account switched off', () => {
  accounts.setAssign('a2', 'off');
  assert.equal(accounts.pick()?.id, 'a1');
  assert.equal(accounts.isFree('a3'), false);
  assert.equal(accounts.hasFree('claude', 'a1'), false);
});

test('account switch: the switch is saved to settings.json', () => {
  accounts.setAssign('a1', 'hour');
  const saved = file().accounts.find((a) => a.id === 'a1')!;
  assert.equal(saved.paused, true);
  assert.ok(saved.pausedUntil && Date.parse(saved.pausedUntil) > Date.now());
  assert.equal(accounts.views().find((a) => a.id === 'a1')!.pausedUntil, saved.pausedUntil);
});

test('account switch: with every account off nothing is picked and tasks wait for one', () => {
  assert.equal(accounts.allPaused(), true);
  assert.equal(accounts.pick(), null);
  assert.equal(accounts.wait('claude')?.kind, 'pause');
  accounts.setAssign('a1', 'off');
  assert.deepEqual(accounts.wait('claude'), { kind: 'off' });
});

test('account switch: switching one back on resumes the waiting work', () => {
  let resumed = 0;
  accounts.on('resumed', () => resumed++);
  accounts.setAssign('a3', 'hour');
  assert.equal(resumed, 0);
  accounts.setAssign('a3', 'on');
  assert.equal(resumed, 1);
  assert.equal(accounts.pick()?.id, 'a3');
  accounts.setAssign('a3', 'on');
  assert.equal(resumed, 1);
});

test('account switch: turn all on switches every account on at once', () => {
  let resumed = 0;
  accounts.on('resumed', () => resumed++);
  accounts.resumeAll();
  assert.equal(resumed, 1);
  assert.equal(accounts.allPaused(), false);
  assert.ok(file().accounts.every((a) => a.paused === false && a.pausedUntil === null));
  accounts.resumeAll();
  assert.equal(resumed, 1);
});
