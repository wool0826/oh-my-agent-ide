import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundsToKeep, parseWindowState, placeWindow, WINDOW_DEFAULT, type Monitor } from '../src/shared/windowState';

const one: Monitor = { workArea: { x: 0, y: 0, width: 1920, height: 1040 }, primary: true };
const two: Monitor = { workArea: { x: 1920, y: 0, width: 2560, height: 1400 } };

test('windowState: nothing saved opens the default size in the middle of the main screen', () => {
  const p = placeWindow(null, [two, one]);
  assert.deepEqual(p.bounds, { x: 300, y: 90, ...WINDOW_DEFAULT });
  assert.equal(p.maximized, false);
});

test('windowState: a window on the second screen opens there again, maximized as it was', () => {
  const saved = { bounds: { x: 2100, y: 200, width: 1400, height: 900 }, maximized: true, fullScreen: false };
  assert.deepEqual(placeWindow(saved, [one, two]), saved);
});

test('windowState: with the second screen gone it opens in the middle of the main one at its own size', () => {
  const saved = { bounds: { x: 2100, y: 200, width: 1120, height: 760 }, maximized: false, fullScreen: false };
  assert.deepEqual(placeWindow(saved, [one]).bounds, { x: 400, y: 140, width: 1120, height: 760 });
});

test('windowState: a window bigger than its screen is fitted to it', () => {
  const saved = { bounds: { x: 1900, y: -20, width: 3000, height: 1600 }, maximized: false, fullScreen: false };
  assert.deepEqual(placeWindow(saved, [one, two]).bounds, { x: 1920, y: 0, width: 2560, height: 1400 });
});

test('windowState: a window half off its screen is moved inside it', () => {
  const saved = { bounds: { x: 1500, y: 600, width: 1000, height: 800 }, maximized: false, fullScreen: true };
  const p = placeWindow(saved, [one]);
  assert.deepEqual(p.bounds, { x: 920, y: 240, width: 1000, height: 800 });
  assert.equal(p.fullScreen, true);
});

test('windowState: a saved state that is not one is ignored', () => {
  assert.equal(parseWindowState(null), null);
  assert.equal(parseWindowState({ bounds: { x: 0, y: 0, width: 0, height: 10 } }), null);
  assert.equal(parseWindowState({ bounds: { x: 'a', y: 0, width: 10, height: 10 } }), null);
  assert.deepEqual(parseWindowState({ bounds: { x: 1.4, y: 2, width: 800, height: 700 }, maximized: 1 }), { bounds: { x: 1, y: 2, width: 800, height: 700 }, maximized: false, fullScreen: false });
});

test('windowState: a window not moved since it opened keeps the bounds it was placed at', () => {
  const placed = { x: 60, y: 40, width: 860, height: 640 };
  const opened = { x: 60, y: 40, width: 862, height: 643 };
  assert.deepEqual(boundsToKeep(opened, opened, placed), placed);
  const moved = { x: 200, y: 40, width: 862, height: 643 };
  assert.deepEqual(boundsToKeep(moved, opened, placed), moved);
});
