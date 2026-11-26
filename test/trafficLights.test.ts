import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// The collapsed macOS sidebar centres the traffic lights: the gap from the panel's left edge to the close
// button equals the gap from the zoom button to the panel's right edge.

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), 'utf8');
const tokens = read('src', 'renderer', 'tokens.css');
const px = (name: string) => {
  const m = tokens.match(new RegExp(`--${name}:\\s*([\\d.]+)px;`));
  assert.ok(m, `--${name} in tokens.css`);
  return Number(m[1]);
};

// Three 12px buttons with 8px between them, at macOS's default size.
const LIGHTS_GROUP = 3 * 12 + 2 * 8;

test('traffic lights: --lights-w is the width of the three buttons', () => {
  assert.equal(px('lights-w'), LIGHTS_GROUP);
});

test('traffic lights: the collapsed rail leaves the same margin on both sides of them', () => {
  const css = read('src', 'renderer', 'styles.css');
  assert.match(css, /\.platform-darwin:not\(\.fullscreen\) \.win \{ --rail-w: calc\(2 \* var\(--lights-x\) \+ var\(--lights-w\) - var\(--panel-inset\)\); \}/);
  const x = px('lights-x'), w = px('lights-w'), inset = px('panel-inset');
  const rail = 2 * x + w - inset;
  // The sidebar panel runs from the inset to the rail's right edge.
  assert.equal(x - inset, rail - (x + w));
});

test('traffic lights: the window puts them at --lights-x', () => {
  const m = read('src', 'main', 'index.ts').match(/trafficLightPosition: mac \? \{ x: (\d+), y: \d+ \}/);
  assert.ok(m, 'trafficLightPosition in src/main/index.ts');
  assert.equal(Number(m[1]), px('lights-x'));
});
