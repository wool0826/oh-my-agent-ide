import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Settings saved before task-end notifications had a switch of their own: "OS notifications" off, results on.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-notify-'));
process.env.OMA_DATA_DIR = tmp;
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ home: path.join(tmp, 'home'), language: 'en', notifications: false, notifyResults: true, sound: 'bell', doneSound: 'custom', accounts: [] }));
const { loadSettings, saveSettings } = await import('../src/main/settings');

test('old notification settings load as two switches that keep what the user had, and the old key is dropped', () => {
  const s = loadSettings();
  assert.equal(s.notifications, false);
  assert.equal(s.notifyDone, false);
  assert.equal('notifyResults' in s, false);
  // The decision sound stays as chosen; a task-end sound that is not on offer falls back to its own default.
  assert.equal(s.sound, 'bell');
  assert.equal(s.doneSound, 'soft');
  saveSettings();
  const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'settings.json'), 'utf8'));
  assert.equal(saved.notifyDone, false);
  assert.equal(saved.notifyResults, undefined);
});
