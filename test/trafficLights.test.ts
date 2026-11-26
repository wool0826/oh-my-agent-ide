import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LIGHTS_PAD_26, LIGHTS_W, LIGHTS_X, trafficLightPosition } from '../src/shared/trafficLights';

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), 'utf8');
const tokens = read('src', 'renderer', 'tokens.css');
const px = (name: string) => {
  const m = tokens.match(new RegExp(`--${name}:\\s*([\\d.]+)px;`));
  assert.ok(m, `--${name} in tokens.css`);
  return Number(m[1]);
};

test('trafficLights: --lights-x and --lights-w are where the window draws the buttons', () => {
  assert.equal(px('lights-x'), LIGHTS_X);
  assert.equal(px('lights-w'), LIGHTS_W);
  assert.equal(LIGHTS_W, 52);
});

test('trafficLights: the collapsed rail leaves the same margin on both sides of them', () => {
  assert.match(read('src', 'renderer', 'styles.css'), /\.platform-darwin:not\(\.fullscreen\) \.win \{ --rail-w: calc\(2 \* var\(--lights-x\) \+ var\(--lights-w\) - var\(--panel-inset\)\); \}/);
  const inset = px('panel-inset');
  const rail = 2 * LIGHTS_X + LIGHTS_W - inset;
  // The sidebar panel runs from the inset to the rail's right edge.
  assert.equal(LIGHTS_X - inset, rail - (LIGHTS_X + LIGHTS_W));
});

test('trafficLights: the user\'s macOS 26 measurement comes out even with the pad', () => {
  // x 22 in an 88px panel: 9px before the close button, 27px after the zoom button. Shifting by the pad and
  // narrowing the panel to the rail of the tokens leaves the same margin on both sides, within a pixel.
  const left = 9 + LIGHTS_PAD_26, width = 88 - 27 - 9;
  const panel = 2 * LIGHTS_X + LIGHTS_W - 2 * px('panel-inset');
  assert.ok(Math.abs(left - (panel - left - width)) <= 1);
});

test('trafficLights: macOS 26 and later get the pad, earlier versions the plain position', () => {
  assert.deepEqual(trafficLightPosition('26.1'), { x: LIGHTS_X + LIGHTS_PAD_26, y: 22 });
  assert.deepEqual(trafficLightPosition('27.0'), { x: LIGHTS_X + LIGHTS_PAD_26, y: 22 });
  assert.deepEqual(trafficLightPosition('15.6.1'), { x: LIGHTS_X, y: 22 });
  assert.deepEqual(trafficLightPosition(''), { x: LIGHTS_X, y: 22 });
});
