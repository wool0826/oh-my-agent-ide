import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampDockH, DOCK_DEF, DOCK_MIN, DOCK_STEP, keyDockH, parseDockH } from '../src/shared/dock';

test('the dock keeps within its least height and the room it has', () => {
  assert.equal(clampDockH(300.4, 600), 300);
  assert.equal(clampDockH(10, 600), DOCK_MIN);
  assert.equal(clampDockH(5000, 600), 600);
  assert.equal(clampDockH(NaN, 600), DOCK_DEF);
  // A window smaller than the least height: the least height.
  assert.equal(clampDockH(300, 40), DOCK_MIN);
});

test('a stored height is read back, and anything else is the first height', () => {
  assert.equal(parseDockH('420'), 420);
  for (const raw of [null, undefined, '', 'x', '-5', '0']) assert.equal(parseDockH(raw), DOCK_DEF);
});

test('the handle: up taller, down shorter, Shift by four steps, within the room; other keys are not its', () => {
  assert.equal(keyDockH('ArrowUp', false, 300, 600), 300 + DOCK_STEP);
  assert.equal(keyDockH('ArrowDown', true, 300, 600), 300 - 4 * DOCK_STEP);
  assert.equal(keyDockH('ArrowUp', true, 590, 600), 600);
  assert.equal(keyDockH('ArrowDown', false, DOCK_MIN + 4, 600), DOCK_MIN);
  assert.equal(keyDockH('ArrowLeft', false, 300, 600), null);
  assert.equal(keyDockH('Enter', false, 300, 600), null);
});
