// End-to-end flows: the macOS traffic lights. The page lays out from the box the window reports around them
// (titleBarOverlay → env(titlebar-area-x/-height), src/shared/trafficLights.ts): the Settings back button, the
// collapsed rail and the bars' middle line. Run with `npm run e2e`.
import assert from 'node:assert/strict';
import { flow } from './harness.mjs';

// In the page: what the layout should be for a box, from the same tokens styles.css reads, and what it is. Returns
// '' when they match, or what differs.
const PROBE = `window.__lights = (box, rail) => {
  const css = getComputedStyle(document.body), px = (n) => parseFloat(css.getPropertyValue(n));
  const k = { x: px('--lights-x'), gap: px('--lights-gap'), inset: px('--panel-inset'), barH: px('--toolbar-h'), padMax: px('--space-12') };
  const full = document.body.classList.contains('fullscreen');
  const zoomRight = box.w - k.x, end = full ? 0 : zoomRight + k.gap, pad = full ? 0 : Math.min(k.padMax, Math.max(0, box.h - k.barH));
  const bad = [];
  const near = (what, got, want) => { if (!(Math.abs(got - want) < 0.5)) bad.push(what + ' ' + got + ' ≠ ' + want); };
  const bar = document.querySelector('.settings-win .stopbar') ?? document.querySelector('.toolbar');
  near('bar padding-top', parseFloat(getComputedStyle(bar).paddingTop), pad);
  const back = document.querySelector('.settings-win .sback');
  if (back) near('back button left', back.getBoundingClientRect().left, Math.max(16, end));
  else if (rail && !document.querySelector('#win').classList.contains('side-min')) bad.push('no rail');
  else if (rail) {
    const s = document.querySelector('.sidebar').getBoundingClientRect();
    if (full) near('rail right', s.right, 60);
    else near('rail panel middle', (s.left + s.right) / 2, box.w / 2);
    const first = [...document.querySelector('.toolbar').children].filter((e) => e.offsetParent).map((e) => e.getBoundingClientRect().left);
    if (!first.length) bad.push('no toolbar controls');
    else if (!full && Math.min(...first) < end - 0.5) bad.push('toolbar starts at ' + Math.min(...first) + ' before ' + end);
  }
  return bad.join('; ');
}; 1`;
const check = (box, rail) => `return window.__lights(${JSON.stringify(box)}, ${rail}) || 'ok'`;

/** Waits until the layout matches the box (the grid animates), and fails with what differs. */
async function settle(app, box, what, rail = false) {
  await app.until(`return (() => { const r = window.__lights(${JSON.stringify(box)}, ${rail}); window.__lastLights = r; return !r; })()`, what, 10_000).catch(async (e) => {
    throw new Error(`${e.message}\nDiffers: ${await app.evaluate('return window.__lastLights')}`);
  });
  assert.equal(await app.evaluate(check(box, rail)), 'ok', what);
}

flow('macOS: the back button, the collapsed rail and the bars follow the box the window reports around the traffic lights', {}, async (app) => {
  await app.evaluate(PROBE);
  const real = await app.evaluate("return document.body.classList.contains('platform-darwin')");
  if (real) {
    // On a Mac the window reports the real AppKit frames; the page uses them as they are.
    const wco = await app.until("return (() => { const o = navigator.windowControlsOverlay; if (!o?.visible) return ''; const r = o.getTitlebarAreaRect(); return r.x > 0 && r.height > 0 ? JSON.stringify({ w: r.x, h: r.height }) : ''; })()", 'the window reporting the traffic lights\' box');
    const box = JSON.parse(wco);
    console.log(`traffic lights box on this Mac: ${box.w}×${box.h}`);
    for (const w of [1320, 900]) {
      await app.size(w, 860);
      await settle(app, box, `the layout for the real box at ${w}px`, w < 960);
    }
    await app.click('[data-action="open-settings"]');
    await settle(app, box, 'the back button after the real lights');
    await app.click('[data-action="close-settings"]');
  } else {
    // Elsewhere the page is made a macOS one; the box comes from the stand-in values below.
    await app.evaluate("document.body.classList.remove('platform-win32', 'platform-linux'); document.body.classList.add('platform-darwin'); 1");
  }
  // Stand-in boxes, as the window would report them: macOS 15's 54pt frames, macOS 26's wider ones, and an odd one.
  for (const box of [{ w: 98, h: 60 }, { w: 104, h: 60 }, { w: 124, h: 72 }]) {
    await app.evaluate(`document.body.style.setProperty('--lights-box-w', '${box.w}px'); document.body.style.setProperty('--lights-box-h', '${box.h}px'); 1`);
    for (const w of [1320, 900, 760]) {
      await app.size(w, 860);
      await settle(app, box, `${box.w}×${box.h} at ${w}px`, w < 960);
      await app.click('[data-action="open-settings"]');
      await settle(app, box, `${box.w}×${box.h} at ${w}px in Settings`);
      await app.click('[data-action="close-settings"]');
    }
  }
  // Fixed numbers for macOS 15's box, so a formula changed the same way here and in styles.css still fails.
  await app.evaluate("document.body.style.setProperty('--lights-box-w', '98px'); document.body.style.setProperty('--lights-box-h', '60px'); 1");
  await app.size(900, 860);
  await app.until("return Math.abs(document.querySelector('.sidebar').getBoundingClientRect().right - 90) < 0.5", 'the rail of the 98px box ending at 90');
  assert.equal(await app.evaluate("return getComputedStyle(document.querySelector('.toolbar')).paddingTop"), '8px');
  await app.click('[data-action="open-settings"]');
  await app.until("return Math.abs(document.querySelector('.settings-win .sback')?.getBoundingClientRect().left - 90) < 0.5", 'the back button of the 98px box at 90');
  await app.click('[data-action="close-settings"]');
  // Full screen hides the lights: no room kept for them, the plain 60px rail.
  await app.evaluate("document.body.classList.add('fullscreen'); 1");
  await app.size(900, 860);
  await settle(app, { w: 124, h: 72 }, 'full screen in the rail', true);
  await app.click('[data-action="open-settings"]');
  await settle(app, { w: 124, h: 72 }, 'full screen in Settings');
});
