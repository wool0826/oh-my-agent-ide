import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backupDay, backupName, backupsNewestFirst, backupsToDrop, stateText } from '../src/shared/backup';

test('a backup is named for its local day', () => {
  assert.equal(backupName(new Date(2026, 10, 2, 23, 59)), 'state-2026-11-02.json');
  assert.equal(backupName(new Date(2026, 10, 2), 'chat'), 'chat-2026-11-02.jsonl');
  assert.equal(backupName(new Date(2026, 10, 2), 'tasks-done'), 'tasks-done-2026-11-02.jsonl');
  assert.equal(backupDay('tasks-done-2026-11-02.jsonl'), '2026-11-02');
});

test('each of the three files keeps its own newest backups', () => {
  const names = [
    'state-2026-11-20.json', 'state-2026-11-21.json', 'state-2026-11-22.json',
    'chat-2026-11-21.jsonl', 'chat-2026-11-22.jsonl', 'chat-broken-1700000000000.jsonl', 'chat.jsonl',
    'tasks-done-2026-11-19.jsonl', 'tasks-done-2026-11-20.jsonl', 'tasks-done-2026-11-22.jsonl', 'tasks-done-2026-11-22.json',
  ];
  assert.deepEqual(backupsNewestFirst(names, 'chat'), ['chat-2026-11-22.jsonl', 'chat-2026-11-21.jsonl']);
  assert.deepEqual(backupsNewestFirst(names, 'tasks-done'), ['tasks-done-2026-11-22.jsonl', 'tasks-done-2026-11-20.jsonl', 'tasks-done-2026-11-19.jsonl']);
  assert.deepEqual(backupsToDrop(names, 2), ['state-2026-11-20.json', 'tasks-done-2026-11-19.jsonl']);
  assert.deepEqual(backupsToDrop(names), []);
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
