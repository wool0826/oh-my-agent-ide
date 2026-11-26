import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LIGHTS_POSITION, LIGHTS_W, LIGHTS_X, LIGHTS_Y, lightsLayout, type LightsTokens } from '../src/shared/trafficLights';

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), 'utf8');
const tokens = read('src', 'renderer', 'tokens.css');
const styles = read('src', 'renderer', 'styles.css');
const main = read('src', 'main', 'index.ts');
const px = (name: string) => {
  const m = tokens.match(new RegExp(`--${name}:\\s*([\\d.]+)px;`));
  assert.ok(m, `--${name} in tokens.css`);
  return Number(m[1]);
};
const k: LightsTokens = { lightsX: px('lights-x'), gap: px('lights-gap'), inset: px('panel-inset'), toolbarH: px('toolbar-h'), padMax: px('space-12') };
/** The box Electron reports: the frames plus the position as a margin on every side. */
const box = (frames: number, buttonH: number) => ({ w: 2 * LIGHTS_X + frames, h: 2 * LIGHTS_Y + buttonH });
// macOS 15: 14pt frames 20pt apart (54); macOS 26: wider frames, about 60 (T-0143). Neither is assumed by the layout.
const boxes = { 'macOS 15': box(54, 16), 'macOS 26': box(60, 16), 'odd frames': box(70, 24) };

test('trafficLights: the tokens match the module', () => {
  assert.equal(px('lights-x'), LIGHTS_X);
  assert.equal(px('lights-w'), LIGHTS_W);
});

test('trafficLights: the window puts the lights at the same spot on every macOS version', () => {
  assert.deepEqual(LIGHTS_POSITION, { x: LIGHTS_X, y: LIGHTS_Y });
  assert.match(main, /trafficLightPosition: mac \? \{ \.\.\.LIGHTS_POSITION \} : undefined/);
  assert.doesNotMatch(main, /getSystemVersion/);
});

test('trafficLights: on macOS the window reports the lights\' box to the page without moving them', () => {
  // `true`, not an object: a height would centre the lights in it (electron#49183).
  assert.match(main, /titleBarOverlay: mac \? true : \{/);
  assert.match(main, /leave-full-screen[^\n]*setWindowButtonPosition/);
});

test('trafficLights: the Settings back button keeps the gap after the zoom button, whatever the frames', () => {
  for (const [name, b] of Object.entries(boxes)) {
    const l = lightsLayout(b, k);
    assert.equal(l.end - l.zoomRight, k.gap, name);
    assert.ok(l.end - l.zoomRight >= 12, name);
  }
  // The token fallback gives what the page had before for 52pt buttons.
  assert.equal(lightsLayout({ w: 2 * LIGHTS_X + LIGHTS_W, h: k.toolbarH }, k).end, 88);
});

test('trafficLights: the collapsed rail\'s panel has the same margin before the close and after the zoom button', () => {
  for (const [name, b] of Object.entries(boxes)) {
    const l = lightsLayout(b, k);
    const frames = b.w - 2 * LIGHTS_X;
    const before = LIGHTS_X - k.inset, after = l.railW - l.zoomRight;
    assert.equal(before, after, `${name}: ${before} / ${after} (frames ${frames})`);
  }
});

test('trafficLights: the bars beside the lights share their middle line, within a bounded padding', () => {
  for (const [name, b] of Object.entries(boxes)) {
    const l = lightsLayout(b, k);
    if (b.h - k.toolbarH <= k.padMax) assert.equal(k.toolbarH / 2 + l.toolbarPad / 2, b.h / 2, name);
    assert.ok(l.toolbarPad >= 0 && l.toolbarPad <= k.padMax, name);
  }
  assert.equal(lightsLayout({ w: 96, h: 30 }, k).toolbarPad, 0);
});

test('trafficLights: styles.css computes the same from env(titlebar-area-*), with the tokens only as the fallback', () => {
  const rule = (sel: string, prop: string) => {
    const blocks = [...styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[1].trim().split('\n').at(-1)!.trim() === sel);
    const decl = blocks.map((m) => m[2].match(new RegExp(`${prop.replace(/[-]/g, '\\-')}:\\s*([^;]+);`))?.[1]).find(Boolean);
    assert.ok(decl, `${sel} { ${prop} }`);
    return decl.trim();
  };
  const mac = '.platform-darwin:not(.fullscreen)';
  assert.equal(rule(mac, '--lights-box-w'), 'env(titlebar-area-x, calc(2 * var(--lights-x) + var(--lights-w)))');
  assert.equal(rule(mac, '--lights-box-h'), 'env(titlebar-area-height, var(--toolbar-h))');
  assert.equal(rule(mac, '--lights-end'), 'calc(var(--lights-box-w) - var(--lights-x) + var(--lights-gap))');
  assert.equal(rule(mac, '--lights-pad'), 'clamp(0px, calc(var(--lights-box-h) - var(--toolbar-h)), var(--space-12))');
  assert.equal(rule(`${mac} .win`, '--rail-w'), 'calc(var(--lights-box-w) - var(--panel-inset))');
  // --lights-w is a fallback only: nothing else lays out from the guessed width.
  assert.equal(styles.match(/var\(--lights-w\)/g)?.length, 1);
  assert.match(rule('.platform-darwin .stopbar > .sback', 'margin-left'), /var\(--lights-end\)/);
});
