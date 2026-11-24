import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampWidth, fitWidths, keyWidth, MAIN_MIN, maxWidth, PANELS, parseWidth, RAIL_W } from '../src/shared/panelWidth';

const wide = { winW: 1600, sideMin: false, insMin: false };
const def = { side: PANELS.side.def, ins: PANELS.ins.def };

test('parseWidth: a stored number is kept within limits; anything else is the default', () => {
  assert.equal(parseWidth('side', '300'), 300);
  assert.equal(parseWidth('side', '300.6'), 301);
  assert.equal(parseWidth('side', '20'), PANELS.side.min);
  assert.equal(parseWidth('ins', '9999'), PANELS.ins.max);
  for (const raw of [null, undefined, '', 'wide', 'NaN']) {
    assert.equal(parseWidth('side', raw), PANELS.side.def, String(raw));
    assert.equal(parseWidth('ins', raw), PANELS.ins.def, String(raw));
  }
});

test('fitWidths: a wide window shows the chosen widths', () => {
  assert.deepEqual(fitWidths({ side: 320, ins: 400 }, wide), { side: 320, ins: 400 });
  assert.deepEqual(fitWidths({ side: 10, ins: 5000 }, wide), { side: PANELS.side.min, ins: PANELS.ins.max });
});

test('fitWidths: a narrow window narrows the right sidebar first, then the left, never below their minimums', () => {
  // 1040 is the window's minimum width (main/index.ts).
  const l = { winW: 1040, sideMin: false, insMin: false };
  assert.deepEqual(fitWidths({ side: 300, ins: 500 }, l), { side: 300, ins: 1040 - 300 - MAIN_MIN });
  assert.deepEqual(fitWidths({ side: 480, ins: 640 }, l), { side: 1040 - PANELS.ins.min - MAIN_MIN, ins: PANELS.ins.min });
  // Smaller than both minimums and the main area: the panels stop at their minimums.
  assert.deepEqual(fitWidths({ side: 480, ins: 640 }, { ...l, winW: 600 }), { side: PANELS.side.min, ins: PANELS.ins.min });
  const shown = fitWidths(def, l);
  assert.ok(l.winW - shown.side - shown.ins >= MAIN_MIN);
});

test('fitWidths: a collapsed panel gives its room to the other and keeps its own width', () => {
  const l = { winW: 1040, sideMin: true, insMin: false };
  assert.deepEqual(fitWidths({ side: 480, ins: 640 }, l), { side: 480, ins: 1040 - RAIL_W - MAIN_MIN });
  assert.deepEqual(fitWidths({ side: 480, ins: 640 }, { ...l, sideMin: false, insMin: true }), { side: 480, ins: 640 });
});

test('maxWidth and clampWidth leave the main area its minimum beside the other panel', () => {
  const l = { winW: 1200, sideMin: false, insMin: false };
  assert.equal(maxWidth('side', def, l), 1200 - def.ins - MAIN_MIN);
  assert.equal(maxWidth('ins', def, l), 1200 - def.side - MAIN_MIN);
  assert.equal(maxWidth('side', def, wide), PANELS.side.max);
  assert.equal(maxWidth('ins', def, { ...l, insMin: true }), Math.min(PANELS.ins.max, 1200 - def.side - MAIN_MIN));
  assert.equal(maxWidth('side', def, { ...l, insMin: true }), PANELS.side.max);
  // Never below the minimum, even when the window has no room.
  assert.equal(maxWidth('side', def, { ...l, winW: 500 }), PANELS.side.min);
  assert.equal(clampWidth('side', 900, def, l), 1200 - def.ins - MAIN_MIN);
  assert.equal(clampWidth('side', 50, def, l), PANELS.side.min);
  assert.equal(clampWidth('ins', 330.4, def, l), 330);
  assert.equal(clampWidth('ins', 300, def, l), PANELS.ins.min);
});

test('keyWidth: arrows move the handle, Shift moves it further, Home and End go to the limits', () => {
  assert.equal(keyWidth('side', 'ArrowRight', false, 272, def, wide), 288);
  assert.equal(keyWidth('side', 'ArrowLeft', true, 272, def, wide), 208);
  // The right sidebar's handle is on its left edge: moving it right narrows the panel.
  assert.equal(keyWidth('ins', 'ArrowRight', false, 344, def, wide), 328);
  assert.equal(keyWidth('ins', 'ArrowLeft', false, 344, def, wide), 360);
  assert.equal(keyWidth('side', 'ArrowLeft', true, PANELS.side.min, def, wide), PANELS.side.min);
  assert.equal(keyWidth('side', 'Home', false, 300, def, wide), PANELS.side.min);
  assert.equal(keyWidth('ins', 'End', false, 300, def, { ...wide, winW: 2000 }), PANELS.ins.max);
  // On 1600 the right sidebar may still pass 640 (the old maximum), up to what leaves MAIN_MIN.
  assert.equal(keyWidth('ins', 'End', false, 300, def, wide), 1600 - def.side - MAIN_MIN);
  assert.equal(keyWidth('ins', 'End', false, 300, def, { winW: 1040, sideMin: false, insMin: false }), 1040 - def.side - MAIN_MIN);
  assert.equal(keyWidth('side', 'Enter', false, 300, def, wide), null);
  assert.equal(keyWidth('side', 'ArrowUp', false, 300, def, wide), null);
});
