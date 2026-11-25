import { test } from 'node:test';
import assert from 'node:assert/strict';
import { midPath } from '../src/shared/pathText';

test('a long path keeps its first and last folders, with the middle left out', () => {
  assert.equal(midPath('C:\\Users\\me\\AppData\\Local\\Temp\\oma-e2e\\home'), 'C:\\Users\\…\\oma-e2e\\home');
  assert.equal(midPath('/Users/me/Library/Application Support/OhMyAgentIDE/home'), '/Users/me/…/OhMyAgentIDE/home');
});

test('a path short enough is shown whole', () => {
  assert.equal(midPath('C:\\Users\\me\\OhMyAgentIDE'), 'C:\\Users\\me\\OhMyAgentIDE');
  assert.equal(midPath('/home/me/a/b/c'), '/home/me/a/b/c');
});
