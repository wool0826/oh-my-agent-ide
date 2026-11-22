import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeQuickKey, quickKeyLabel } from '../src/shared/quickKey';

test('a typed shortcut is spelled the way Electron wants it', () => {
  assert.equal(normalizeQuickKey('ctrl + shift + k'), 'Control+Shift+K');
  assert.equal(normalizeQuickKey('Shift+CmdOrCtrl+space'), 'CommandOrControl+Shift+Space');
  assert.equal(normalizeQuickKey('alt+f5'), 'Alt+F5');
  assert.equal(normalizeQuickKey('  '), '');
});

test('what is not a usable shortcut is refused', () => {
  for (const bad of ['k', 'shift+k', 'ctrl+', 'ctrl+a+b', 'ctrl+@', 'hello', 'ctrl+f25']) assert.equal(normalizeQuickKey(bad), null, bad);
});

test('the shortcut reads in the platform\'s own way', () => {
  assert.equal(quickKeyLabel('CommandOrControl+Shift+Space', false), 'Ctrl+Shift+Space');
  assert.equal(quickKeyLabel('CommandOrControl+Shift+Space', true), '⌘⇧Space');
  assert.equal(quickKeyLabel('', false), '');
});
