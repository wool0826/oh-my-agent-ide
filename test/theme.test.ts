import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanTheme, effectiveTheme, windowColors } from '../src/shared/theme';

test('an unknown stored theme is dark', () => {
  assert.equal(cleanTheme('light'), 'light');
  assert.equal(cleanTheme('system'), 'system');
  assert.equal(cleanTheme('dark'), 'dark');
  assert.equal(cleanTheme('sepia'), 'dark');
  assert.equal(cleanTheme(undefined), 'dark');
});

test('system follows the OS, the others do not', () => {
  assert.equal(effectiveTheme('system', true), 'dark');
  assert.equal(effectiveTheme('system', false), 'light');
  assert.equal(effectiveTheme('light', true), 'light');
  assert.equal(effectiveTheme('dark', false), 'dark');
});

test('the window backdrop matches the page canvas of each look', () => {
  assert.equal(windowColors('dark').background, '#131316');
  assert.equal(windowColors('light').background, '#ececf0');
  assert.notEqual(windowColors('dark').symbol, windowColors('light').symbol);
});
