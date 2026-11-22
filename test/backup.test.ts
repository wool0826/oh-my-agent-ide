import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backupName, backupsNewestFirst, backupsToDrop, stateText } from '../src/shared/backup';

test('a backup is named for its local day', () => {
  assert.equal(backupName(new Date(2026, 10, 2, 23, 59)), 'state-2026-11-02.json');
});

test('only the newest backups are kept, and other files are not touched', () => {
  const names = ['state-2026-11-20.json', 'state.json', 'state-2026-11-22.json', 'notes.txt', 'state-2026-11-21.json', 'state-broken-2026-11-22.json'];
  assert.deepEqual(backupsNewestFirst(names), ['state-2026-11-22.json', 'state-2026-11-21.json', 'state-2026-11-20.json']);
  assert.deepEqual(backupsToDrop(names, 2), ['state-2026-11-20.json']);
  assert.deepEqual(backupsToDrop(names), []);
});

test('a state file is broken only when it holds something that is not a JSON object', () => {
  assert.equal(stateText('{"tasks":[]}'), 'ok');
  assert.equal(stateText('\uFEFF{"tasks":[]}'), 'ok');
  assert.equal(stateText(null), 'empty');
  assert.equal(stateText('  \n'), 'empty');
  assert.equal(stateText('{"tasks":['), 'broken');
  assert.equal(stateText('[]'), 'broken');
  assert.equal(stateText('null'), 'broken');
});
