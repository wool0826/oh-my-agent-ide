import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { STRIP_H, cleanTheme, effectiveTheme, windowButtons, windowColors } from '../src/shared/theme';

const read = (p: string) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

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

test("strip: the window's buttons are as tall as the top strip on every system", () => {
  for (const os of ['darwin', 'win32', 'linux']) for (const look of ['dark', 'light'] as const) assert.equal(windowButtons(os, look).height, STRIP_H, `${os}, ${look}`);
  assert.match(read('src/renderer/tokens.css'), new RegExp(`^  --toolbar-h: ${STRIP_H}px;$`, 'm'));
});

test('strip: macOS gets the height and no position, so Electron centres the traffic lights in it', () => {
  assert.deepEqual(windowButtons('darwin', 'dark'), { height: STRIP_H });
  assert.deepEqual(windowButtons('darwin', 'light'), { height: STRIP_H });
  // A position beside the height stops the centring, and misplaces the lights on macOS 26 (electron#49183).
  assert.doesNotMatch(read('src/main/index.ts'), /trafficLightPosition|hiddenInset/);
});

test("strip: the caption buttons take the look's colour over nothing of their own", () => {
  assert.deepEqual(windowButtons('win32', 'light'), { height: STRIP_H, color: '#00000000', symbolColor: windowColors('light').symbol });
  assert.deepEqual(windowButtons('linux', 'dark'), { height: STRIP_H, color: '#00000000', symbolColor: windowColors('dark').symbol });
});

test("strip: only the strip's two ends read the box the window reports, and the left sidebar is below the strip", () => {
  const css = read('src/renderer/styles.css');
  const readers = css.split('\n').filter((l) => !l.trimStart().startsWith('/*') && l.includes('env(titlebar-area-'));
  assert.equal(readers.length, 2, readers.join('\n'));
  assert.ok(readers[0].startsWith('.platform-darwin:not(.fullscreen) { --strip-start: '), readers[0]);
  assert.ok(readers[1].startsWith('.platform-win32, .platform-linux { --strip-end: '), readers[1]);
  assert.match(css, /^\.sidebar \{ grid-row: 2; /m);
  assert.match(css, /^\.toolbar \{ grid-row: 1; grid-column: 1 \/ 4; /m);
  // Nothing is left of the rules that laid things out around the lights.
  assert.doesNotMatch(css, /--lights-|\.lights\b/);
});
