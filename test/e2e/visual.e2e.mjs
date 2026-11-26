// Screen comparison: the main screens (chat, Workers, Notifications, settings, palette) in the dark and the light theme,
// drawn with fake agents, fixed data and a stopped clock at a fixed size, against the pictures in test/e2e/visual/.
// Fonts draw differently on each system, so the pictures are of one system (BASE_OS) and the flows run only there;
// CI runs them as their own job (visual), and `npm run e2e` leaves them out. Run with `npm run e2e:visual`; after a change that is meant to change the
// look, write the pictures again with `npm run e2e:visual:update` and look at them in the PR.
// A screen that differs leaves <screen>-expected.png, -actual.png and -diff.png (in red) in test-results/visual/.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { flow, failuresDir } from './harness.mjs';
import { compare, decode, encode } from './png.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR = path.join(here, 'visual');
const OUT_DIR = path.join(path.dirname(failuresDir), 'visual');
const BASE_OS = 'win32';
const UPDATE = process.execArgv.includes('--test-update-snapshots');
const W = 1280, H = 800;
// When the data is made (the main process's clock, test/e2e/still.cjs) and when the window looks at it: an hour later.
const MADE_AT = '2026-03-02T09:00:00Z';
const SEEN_AT = Date.parse(MADE_AT) + 3600e3;
// A pixel differs when a channel is more than THRESHOLD apart; a screen differs when more than MAX_SHARE of it does.
const THRESHOLD = 8;
const MAX_SHARE = 0.0005;

// Before the window's own scripts: the window's clock stands at SEEN_AT, nothing moves (animations, transitions, the
// caret), and what every release changes (the version in Settings) is not drawn.
const FREEZE = `(() => {
  const Real = Date;
  class Seen extends Real { constructor(...a) { if (a.length) super(...a); else super(${SEEN_AT}); } static now() { return ${SEEN_AT}; } }
  globalThis.Date = Seen;
  const css = '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; } #ver-n { visibility: hidden; }';
  const add = () => { const s = document.createElement('style'); s.id = 'e2e-still'; s.textContent = css; document.head.append(s); };
  if (document.head) add(); else document.addEventListener('DOMContentLoaded', add, { once: true });
})();`;

/** Makes the window still and the size of the pictures, then loads it again so its scripts start on the stopped clock. */
async function freeze(app) {
  await app.cdp('Page.enable');
  await app.cdp('Page.addScriptToEvaluateOnNewDocument', { source: FREEZE });
  await app.cdp('Emulation.setTimezoneOverride', { timezoneId: 'UTC' });
  // Focused, whichever window has the focus on the desktop.
  await app.cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
  await app.cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await app.cdp('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await app.cdp('Page.reload', { ignoreCache: true });
  await app.until(`!!document.querySelector('#chat-ins .seg') && !!document.getElementById('e2e-still') && window.innerWidth === ${W} && window.innerHeight === ${H} && Date.now() === ${SEEN_AT}`, `the still window at ${W}×${H}`);
}

/** Gives up on a promise after `ms`, so a window that stops answering cannot hold the run. */
const within = (p, ms, what) => {
  let timer;
  return Promise.race([p, new Promise((_, j) => { timer = setTimeout(() => j(new Error(`${what}: no answer in ${ms} ms`)), ms); })]).finally(() => clearTimeout(timer));
};

/** Compares what the page shows (all of it, or the element `clip` names) with its picture, once the fonts are in. */
async function look(app, name, misses, clip = null) {
  const area = await app.evaluate(`await document.fonts.ready;
    const r = ${clip ? `document.querySelector(${JSON.stringify(clip)}).getBoundingClientRect()` : 'null'};
    return r && { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height), scale: 1 };`);
  const m = await within(app.cdp('Page.captureScreenshot', { format: 'png', ...(area ? { clip: area } : {}) }), 20_000, `the picture of ${name}`);
  const png = Buffer.from(m.result.data, 'base64');
  const file = path.join(BASE_DIR, `${name}.png`);
  if (UPDATE || !fs.existsSync(file)) {
    fs.mkdirSync(BASE_DIR, { recursive: true });
    fs.writeFileSync(file, png);
    if (!UPDATE) misses.push(`${name}: no picture yet; wrote ${path.relative(process.cwd(), file)}`);
    return;
  }
  const expected = decode(fs.readFileSync(file)), actual = decode(png);
  const { size, differ, diff } = compare(expected, actual, THRESHOLD);
  const allowed = Math.floor(expected.w * expected.h * MAX_SHARE);
  if (size && differ <= allowed) return;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.copyFileSync(file, path.join(OUT_DIR, `${name}-expected.png`));
  fs.writeFileSync(path.join(OUT_DIR, `${name}-actual.png`), png);
  if (diff) fs.writeFileSync(path.join(OUT_DIR, `${name}-diff.png`), encode(diff));
  misses.push(size ? `${name}: ${differ} pixels differ (${allowed} allowed)` : `${name}: ${actual.w}×${actual.h}, the picture is ${expected.w}×${expected.h}`);
}

for (const theme of ['dark', 'light']) {
  const opts = {
    settings: { theme },
    // The main process's clock almost stopped, and its window shown off the screen (test/e2e/still.cjs).
    env: { NODE_OPTIONS: `--require "${path.join(here, 'still.cjs').replaceAll('\\', '/')}"`, OMA_E2E_CLOCK: MADE_AT, OMA_E2E_OFFSCREEN: '1', TZ: 'UTC' },
    // Grey text smoothing and one pixel per point, whatever the screen's own settings are, and a window off the screen
    // that is drawn as if it were in view.
    args: ['--disable-lcd-text', '--force-device-scale-factor=1', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
      '--disable-background-timer-throttling', '--disable-features=CalculateNativeWinOcclusion'],
  };
  const run = process.platform === BASE_OS ? flow : (name) => test.skip(`${name} (pictures are of ${BASE_OS})`);
  run(`the main screens look as they did, in the ${theme} theme`, opts, async (app) => {
    // A finished task with its result, and one waiting on a decision: something on every screen.
    await app.say(['Hello', '@fake task - Write the release notes', '@@fake result Wrote the release notes for 0.7.0.'].join('\n'));
    await app.until("window.ide.call('state').then((s) => s.tasks.some((t) => t.status === 'done'))", 'the first task done');
    await app.say(['@fake task - Update the changelog', '@@fake permission npm install left-pad'].join('\n'));
    await app.until("!!document.querySelector('#chat-ins .dec')", 'the decision waiting');
    await freeze(app);
    const misses = [];
    const shot = (screen, clip) => look(app, `${screen}-${theme}`, misses, clip);

    await app.until("document.querySelectorAll('#chat-thread .attach[data-task]').length >= 1", 'the chat with the result card');
    await shot('chat');

    await app.click('button[data-v="worker"]');
    await app.until("!!document.querySelector('#wk-list .wrow [data-action=\"select-worker\"]')", 'the Workers list');
    await app.click('#wk-list .wrow [data-action="select-worker"]');
    await app.until("!!document.querySelector('#ws-thread .bub')", 'the Worker conversation');
    await shot('workers');

    // The Inbox on its own: a picture of the right sidebar, where a small change is a larger share of the picture.
    await app.click('button[data-v="chat"]');
    await app.click('#chat-ins [data-action="ins-tab"][data-v="inbox"]');
    await app.until("document.querySelectorAll('#chat-ins .dec, #chat-ins .res').length >= 2", 'the Inbox with a decision and a result');
    await shot('inbox', '#chat-ins');

    await app.click('[data-action="open-settings"]');
    await app.until("!!document.getElementById('set-q')?.offsetParent", 'the settings');
    await shot('settings');
    await app.key('Escape', 'Escape', 27);
    await app.until("!document.getElementById('set-q')?.offsetParent", 'the settings closed');

    await app.key('KeyK', 'k', 75, process.platform === 'darwin' ? 4 : 2);
    await app.until("document.activeElement?.id === 'cmdk-q'", 'the palette');
    await shot('palette');

    assert.deepEqual(misses, [], `Screens that look different; their pictures are in ${OUT_DIR}`);
  });
}
