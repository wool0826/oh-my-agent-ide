// End-to-end flows: the top strip. It runs across the window, both sidebars and the main column start below it, and
// it is the only row the window's own buttons lie over: the traffic lights at its start on macOS, the caption buttons
// at its end elsewhere (T-0159, styles.css: --strip-start / --strip-end). Run with `npm run e2e`.
import assert from 'node:assert/strict';
import { flow } from './harness.mjs';

// In the page: what differs from the layout for `want`, or '' when nothing does.
//   start, end   the strip's padding (px) on each side; null leaves that side to the window's own report
//   lights, caps how far the window's buttons reach in from the left and from the right (px)
const PROBE = `window.__strip = (want) => {
  const bad = [];
  const near = (what, got, to) => { if (!(Math.abs(got - to) < 0.5)) bad.push(what + ' ' + got + ' ≠ ' + to); };
  const box = (e) => e.getBoundingClientRect();
  const shown = (e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  const settings = document.querySelector('#sheet:not([hidden])');
  const bar = document.querySelector('.toolbar'), strip = settings ? settings.querySelector('.stopbar') : bar;
  const h = parseFloat(getComputedStyle(document.body).getPropertyValue('--toolbar-h'));
  const s = box(strip), pad = getComputedStyle(bar);
  near('strip left', s.left, 0); near('strip top', s.top, 0); near('strip right', s.right, innerWidth); near('strip height', s.height, h);
  if (want.start != null) near('strip start', parseFloat(pad.paddingLeft), want.start);
  if (want.end != null) near('strip end', parseFloat(pad.paddingRight), want.end);
  const from = parseFloat(pad.paddingLeft), to = innerWidth - parseFloat(pad.paddingRight);
  if (settings) {
    near('back button left', box(settings.querySelector('.sback')).left, from);
    near('settings nav top', box(settings.querySelector('.snav')).top, s.bottom);
  } else {
    // The panels and the main column: below the strip, never beside it; the panels and the main column's contents a
    // --space-12 gap lower (T-0169).
    const main = document.querySelector('.content.view:not([hidden])'), ins = document.querySelector('.inspector.view:not([hidden])'), side = document.querySelector('.sidebar');
    const gap = parseFloat(getComputedStyle(document.body).getPropertyValue('--space-12'));
    near('left sidebar top', box(side).top, s.bottom + gap); near('main column top', box(main).top, s.bottom); near('right sidebar top', box(ins).top, s.bottom + gap);
    near('main column inset', parseFloat(getComputedStyle(main).paddingTop), gap);
    if (document.querySelector('#win').classList.contains('side-min')) {
      near('rail right', box(side).right, 60);
      // Away from the traffic lights the sidebar's button stands over the rail's icons (T-0170).
      const mid = (r) => (r.left + r.right) / 2, icon = side.querySelector('.rail-b');
      if (!document.body.classList.contains('platform-darwin') && icon) near('sidebar button over the rail', mid(box(document.querySelector('#side-toggle'))), mid(box(icon)));
    }
    // What the strip holds: in order, apart, and between its two ends.
    const kids = [...bar.children].filter(shown);
    if (!kids.length || kids[0].id !== 'side-toggle') bad.push('the sidebar button is not first in the strip');
    kids.forEach((e, i) => {
      const r = box(e), name = e.id || e.className;
      if (r.left < from - 0.5) bad.push(name + ' starts at ' + r.left + ', before ' + from);
      if (r.right > to + 0.5) bad.push(name + ' ends at ' + r.right + ', after ' + to);
      if (r.top < -0.5 || r.bottom > s.bottom + 0.5) bad.push(name + ' leaves the strip: ' + r.top + '–' + r.bottom);
      if (i && r.left < box(kids[i - 1]).right - 0.5) bad.push(name + ' overlaps ' + (kids[i - 1].id || kids[i - 1].className));
    });
    // The view tabs start on the main column's line, or right after the sidebar's button where that is further right;
    // a short strip cuts their end, never moves their start.
    const toggle = box(document.querySelector('#side-toggle'));
    near('view tabs left', box(document.querySelector('#views')).left, Math.max(box(main).left + 12, toggle.right + 8));
  }
  // Under the window's own buttons there is the strip and nothing in it.
  const plain = (e) => e === document.documentElement || e === document.body || e.id === 'win' || e.id === 'sheet' || e === bar || e.classList.contains('stopbar');
  const under = (x0, x1, whose) => {
    const hit = new Set();
    for (let x = x0 + 1; x < x1; x += 5) for (let y = 1; y < h; y += 5) for (const e of document.elementsFromPoint(x, y)) if (!plain(e)) hit.add(e.id || e.className || e.tagName);
    if (hit.size) bad.push([...hit].join(', ') + ' under the ' + whose);
  };
  under(0, want.lights ?? 0, 'traffic lights'); under(innerWidth - (want.caps ?? 0), innerWidth, 'caption buttons');
  if (document.documentElement.scrollWidth > innerWidth) bad.push('the page scrolls sideways');
  return bad.join('; ');
}; 1`;

/** Waits until the layout is the one for `want` (the grid animates, the window reports its box late), and fails with what differs. */
async function settle(app, want, what) {
  const js = `window.__strip(${typeof want === 'string' ? want : JSON.stringify(want)})`;
  await app.until(`return (() => { const r = ${js}; window.__stripLast = r; return !r; })()`, what, 10_000).catch(async (e) => {
    throw new Error(`${e.message}\nDiffers: ${await app.evaluate('return window.__stripLast')}`);
  });
  assert.equal(await app.evaluate(`return ${js} || 'ok'`), 'ok', what);
}

const WIDTHS = [1400, 1000, 900, 760];

/** The layout for `want` at every width: wide, the right sidebar as a drawer, the left one as a rail, the narrowest window. Settings at both ends. */
async function everyWidth(app, want, what) {
  for (const w of WIDTHS) {
    await app.size(w, 860);
    await settle(app, want, `${what} at ${w}px`);
    if (w !== WIDTHS[0] && w !== WIDTHS.at(-1)) continue;
    await app.click('[data-action="open-settings"]');
    await app.until("return !!document.querySelector('#sheet:not([hidden]) .sback')", 'Settings open');
    await settle(app, want, `${what} at ${w}px in Settings`);
    await app.click('[data-action="close-settings"]');
    await app.until("return !document.querySelector('#sheet:not([hidden])')", 'Settings closed');
  }
}

const system = (app, name) => app.evaluate(`document.body.classList.remove('platform-darwin', 'platform-win32', 'platform-linux', 'fullscreen'); document.body.classList.add(${JSON.stringify(name)}); document.body.style.removeProperty('--strip-start'); document.body.style.removeProperty('--strip-end'); 1`);

flow("the top strip crosses the window, the panels start below it, and nothing in it is under the window's own buttons", {}, async (app) => {
  await app.evaluate(PROBE);
  const mac = await app.evaluate("return document.body.classList.contains('platform-darwin')");

  // This system, with the box its window reports (the same numbers env(titlebar-area-*) gives styles.css).
  if (mac) {
    const box = await app.until("return (() => { const o = navigator.windowControlsOverlay; if (!o?.visible) return ''; const r = o.getTitlebarAreaRect(); return r.x > 0 && r.height > 0 ? r.x + '×' + r.height : ''; })()", "the window reporting the traffic lights' box");
    console.log(`traffic lights box on this Mac: ${box}`);
    const x = parseFloat(box);
    // As tall as the strip: that is the height the lights are centred in.
    assert.equal(box.split('×')[1], '44', box);
    await everyWidth(app, { start: Math.max(78, x) + 8, end: 12, lights: x }, 'this Mac');
  } else {
    // The page's width is set by the test and the window's is not, so the reported box is read in the page each time.
    const real = "(() => { const o = navigator.windowControlsOverlay, r = o?.visible ? o.getTitlebarAreaRect() : null; const caps = r && r.width > 0 ? innerWidth - r.x - r.width : 0; const end = Math.max(150, caps + 12); return { start: 12, end, caps: end - 12 }; })()";
    await everyWidth(app, real, 'this system');
  }

  // macOS with stand-in boxes: macOS 15's lights where the system puts them, wider ones (macOS 26), and an odd one.
  await system(app, 'platform-darwin');
  for (const lights of [78, 92, 124]) {
    await app.evaluate(`document.body.style.setProperty('--strip-start', '${lights + 8}px'); 1`);
    await everyWidth(app, { start: lights + 8, end: 12, lights }, `macOS, lights ${lights}px wide`);
  }
  // Before a Mac's window reports its box the strip keeps the usual one clear (78: what macOS 15 reports). (A Mac reports its own, checked above.)
  if (!mac) {
    await system(app, 'platform-darwin');
    await everyWidth(app, { start: 86, end: 12, lights: 78 }, 'macOS before the window reports');
  }
  // Full screen hides the lights: the strip starts at the window's edge.
  await system(app, 'platform-darwin');
  await app.evaluate("document.body.classList.add('fullscreen'); 1");
  await everyWidth(app, { start: 12, end: 12 }, 'macOS in full screen');

  // Windows with stand-in boxes: the caption buttons at 100%, and wider ones (a zoomed-out page).
  await system(app, 'platform-win32');
  for (const caps of [138, 230]) {
    await app.evaluate(`document.body.style.setProperty('--strip-end', '${caps + 12}px'); 1`);
    await everyWidth(app, { start: 12, end: caps + 12, caps }, `Windows, caption buttons ${caps}px wide`);
  }
});
