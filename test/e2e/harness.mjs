// Starts the built app on an empty profile with fake agents and a stand-in for gh, and drives its window over
// the Chrome DevTools Protocol. Nothing here uses an account, a model or the network.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const electron = createRequire(import.meta.url)('electron'); // the path of the Electron executable
// Only for the pause between two looks at a condition, or between the moves of a gesture: never as the wait itself.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** A promise that gives up after `ms`, so a window that no longer answers cannot hold a test. */
const within = (p, ms, what) => {
  let timer;
  return Promise.race([p, new Promise((_, j) => { timer = setTimeout(() => j(new Error(`${what}: no answer in ${ms} ms`)), ms); })]).finally(() => clearTimeout(timer));
};

/**
 * What the helpers wait on, kept by the page: the last element it got a mouseover for (the event the tooltip listens
 * to) and when, when it got its last pointer move, and how many resize events it got. Put in again after a reload.
 */
const PROBE = "if (!window.__e2e) { window.__e2e = { over: null, overAt: 0, movedAt: 0, resized: 0 }; addEventListener('mouseover', (e) => { __e2e.over = e.target; __e2e.overAt = performance.now(); }, true); addEventListener('pointermove', () => { __e2e.movedAt = performance.now(); }, true); addEventListener('resize', () => { __e2e.resized++; }); } return 1;";

/** Where a failed flow leaves its picture, page and logs (uploaded by CI): OMA_E2E_OUT, or test-results/e2e. */
export const failuresDir = process.env.OMA_E2E_OUT || path.join(root, 'test-results', 'e2e');
const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'flow';

/** The logs of a launch: the app's own log and what Electron printed. */
function copyLogs(dir, home, out) {
  for (const [from, to] of [[path.join(home, 'data', 'app.log'), 'app.log'], [path.join(dir, 'app.log'), 'electron.log']]) {
    try { fs.copyFileSync(from, path.join(out, to)); } catch { /* not written */ }
  }
}

/**
 * Runs a flow against a fresh app and always stops it. When it fails, a picture of the window, the page's DOM and
 * the app's logs are saved under failuresDir/<flow name>, and the test output says where.
 */
export function flow(name, opts, fn) {
  test(name, { timeout: 120_000 }, async () => {
    let app;
    try {
      app = await launch(opts);
    } catch (e) {
      if (e.dir) {
        const out = path.join(failuresDir, slug(name));
        fs.mkdirSync(out, { recursive: true });
        fs.writeFileSync(path.join(out, 'error.txt'), String(e.stack ?? e));
        copyLogs(e.dir, e.home, out);
        console.error(`e2e: the app's logs for "${name}" are in ${out}`);
      }
      throw e;
    }
    try {
      await fn(app);
    } catch (e) {
      await app.keep(path.join(failuresDir, slug(name)), e).then((out) => console.error(`e2e: what "${name}" showed is in ${out}`), (x) => console.error(`e2e: could not keep what "${name}" showed: ${x.message}`));
      throw e;
    } finally {
      await app.stop();
    }
  });
}

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

/**
 * A registered repository's checkout: a clone with one commit on main, whose origin is a bare repository beside
 * it, so the app's fetches and `origin/main` work without a network.
 */
function makeRepo(dir) {
  const remote = `${dir}.git`;
  fs.mkdirSync(remote, { recursive: true });
  git(remote, 'init', '-q', '--bare', '-b', 'main');
  git(path.dirname(dir), 'clone', '-q', remote, dir);
  fs.writeFileSync(path.join(dir, 'README.md'), '# Demo\n');
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=E2E', '-c', 'user.email=e2e@example.invalid', 'commit', '-q', '-m', 'Start');
  git(dir, 'branch', '-M', 'main');
  git(dir, 'push', '-q', 'origin', 'main');
}

/**
 * Launches the app. `settings` is merged over the test defaults; `repos` names repositories to create and register
 * (each at https://github.com/o/<name>); `gh` seeds the stand-in's file (prs, issues); `env` adds to the app's environment;
 * `args` adds to Electron's command line (Chromium switches).
 */
export async function launch({ settings = {}, repos = [], gh = {}, files = {}, env = {}, args = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-e2e-'));
  const data = path.join(dir, 'data');
  const home = path.join(dir, 'home');
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(path.join(home, 'data'), { recursive: true });
  const ghFile = path.join(dir, 'gh.json');
  fs.writeFileSync(ghFile, JSON.stringify({ prs: {}, issues: [], calls: [], ...gh }));
  // English, so the tests read the same text everywhere. Background on with --hidden keeps the window off the screen.
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ language: 'en', home, updateCheck: false, quickKey: '', background: true, notifications: false, sound: 'none', ...settings }));
  const repoRows = repos.map((name) => {
    const p = path.join(dir, 'repos', name);
    makeRepo(p);
    return { name, url: `https://github.com/o/${name}`, path: p, description: 'e2e', defaultBranch: 'main', addedAt: new Date().toISOString() };
  });
  if (repoRows.length) fs.writeFileSync(path.join(home, 'data', 'state.json'), JSON.stringify({ repos: repoRows }));

  // Files a test wants in place before the app starts, by their path under the home folder (a state file, a backup).
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
    fs.writeFileSync(path.join(home, rel), text);
  }

  const port = await freePort();
  // The same profile and port each time, so restart() brings back the app a user would find after quitting it.
  const startApp = (more = [`--remote-debugging-port=${port}`]) => {
    const log = fs.openSync(path.join(dir, 'app.log'), 'a');
    return spawn(electron, ['.', ...more, '--hidden', ...args], {
      cwd: root, stdio: ['ignore', log, log],
      env: { ...process.env, OMA_FAKE_AGENT: '1', OMA_DATA_DIR: data, OMA_GH_STUB: path.join(here, 'gh-stub.mjs'), OMA_E2E_GH: ghFile, ELECTRON_ENABLE_LOGGING: '1', ...env },
    });
  };
  let child = startApp();
  /** Ends the app and waits until it is gone; a quit that hangs is ended for good. */
  const endApp = () => new Promise((r) => {
    // This app, not whichever one `child` names by the time the timer fires (restart() starts the next at once).
    const c = child;
    if (c.exitCode !== null || c.signalCode !== null) { r(); return; }
    const hung = setTimeout(() => { c.kill('SIGKILL'); r(); }, 3000);
    c.once('exit', () => { clearTimeout(hung); r(); });
    c.kill();
  });

  let ws;
  const deadline = Date.now() + 40_000;
  for (;;) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = pages.find((p) => p.type === 'page' && p.url.endsWith('index.html'));
      if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); }); break; }
    } catch { /* not up yet */ }
    if (Date.now() > deadline) { child.kill(); throw Object.assign(new Error(`The app did not start. Log: ${fs.readFileSync(path.join(dir, 'app.log'), 'utf8').slice(-2000)}`), { dir, home }); }
    await sleep(250);
  }
  let id = 0;
  const waiting = new Map();
  const onMessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } };
  ws.addEventListener('message', onMessage);
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });

  /** Evaluates an expression (or the body of an async function when it has `await` or `return`) in the page. */
  async function evaluate(js) {
    const expression = /\b(await|return)\b/.test(js) ? `(async () => { ${js} })()` : js;
    const m = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (m.result?.exceptionDetails) throw new Error(`In the page: ${m.result.exceptionDetails.exception?.description ?? m.result.exceptionDetails.text}\n${js}`);
    return m.result?.result?.value;
  }

  /**
   * A picture of the window. A capture waits for the window's next frame, and a hidden window with nothing new to
   * show makes none (a state update draws only the panels that changed, decision 215): the page changes for two
   * frames after the request, so one comes.
   */
  async function capture(params = {}) {
    const shot = send('Page.captureScreenshot', { format: 'png', ...params });
    await evaluate("document.body.style.opacity = '0.999'; requestAnimationFrame(() => requestAnimationFrame(() => { document.body.style.opacity = ''; })); 1").catch(() => {});
    return shot;
  }

  /**
   * Waits until the expression is truthy in the page and returns its value. `show`, a page expression, says what the
   * failure message shows of the page (the sidebars by default).
   */
  async function until(js, what = js, timeoutMs = 20_000, show = "document.querySelector('#side')?.innerText + ' | ' + (document.querySelector('.inspector:not([hidden])')?.innerText ?? '').slice(0, 600)") {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const v = await evaluate(js);
      if (v) return v;
      if (Date.now() > end) {
        const state = await evaluate(show).catch((x) => `(could not read: ${x.message})`);
        throw new Error(`Timed out after ${timeoutMs} ms waiting for: ${what}\nOn screen: ${state}`);
      }
      await sleep(150);
    }
  }

  /** A second page of the app (the quick message box), with the same ways of driving it. */
  let quick = null;
  async function attach(url) {
    const sock = new WebSocket(url);
    await new Promise((r, j) => { sock.addEventListener('open', r); sock.addEventListener('error', j); });
    let n = 0;
    const open = new Map();
    sock.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && open.has(m.id)) { open.get(m.id)(m); open.delete(m.id); } });
    const ask = (method, params = {}) => new Promise((r) => { const i = ++n; open.set(i, r); sock.send(JSON.stringify({ id: i, method, params })); });
    const run = async (js) => {
      const expression = /\b(await|return)\b/.test(js) ? `(async () => { ${js} })()` : js;
      const m = await ask('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (m.result?.exceptionDetails) throw new Error(`In the page: ${m.result.exceptionDetails.exception?.description ?? m.result.exceptionDetails.text}\n${js}`);
      return m.result?.result?.value;
    };
    return {
      evaluate: run,
      async until(js, what = js, timeoutMs = 15_000) {
        const end = Date.now() + timeoutMs;
        for (;;) {
          const v = await run(js);
          if (v) return v;
          if (Date.now() > end) throw new Error(`Timed out waiting for: ${what}`);
          await sleep(120);
        }
      },
      async shot(file) {
        const m = await ask('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(file, Buffer.from(m.result.data, 'base64'));
      },
      /** A raw DevTools protocol call on this page (a drop of files, for one). */
      cdp: ask,
      close: () => sock.close(),
    };
  }

  // The first state has arrived and the window is drawn. If it never is, the app must not be left running:
  // a child still alive keeps the test process from ending.
  try {
    await until("!!document.querySelector('#chat-ins .seg')", 'the main window');
  } catch (e) {
    const page = await evaluate("document.readyState + ' | ' + location.href + ' | ide=' + typeof window.ide + ' | body=' + document.body.innerText.slice(0, 300)").catch((x) => String(x));
    try { ws.close(); } catch { /* closed */ }
    child.kill('SIGKILL');
    throw Object.assign(new Error(`${e.message}\nPage: ${page}\nApp log: ${fs.readFileSync(path.join(dir, 'app.log'), 'utf8').slice(-3000)}`), { dir, home });
  }
  // On a screen too small for the window's default size (a CI screen narrower than 1100), the page is made as wide
  // as that size, or the right sidebar would start as a closed drawer (I1). A wide screen keeps the real width.
  // Its height stays the window's own, so the pointer still reaches the bottom of the page. Here too, a failure
  // stops the app before it is reported.
  try {
    await widen();
  } catch (e) {
    try { ws.close(); } catch { /* closed */ }
    child.kill('SIGKILL');
    throw Object.assign(e, { dir, home });
  }

  async function widen() {
    await evaluate(PROBE);
    if (await evaluate('window.innerWidth') < 1100) {
      const before = await evaluate('__e2e.resized');
      await send('Emulation.setDeviceMetricsOverride', { width: 1320, height: await evaluate('window.innerHeight'), deviceScaleFactor: 1, mobile: false });
      // A window off screen may lay the page out and send its resize event only with an input after the change, and
      // that event closes a tooltip and cancels one about to show: moves over an empty corner of the window until the
      // page is at that width and has had the event, so it cannot land in the middle of the flow.
      const ready = `document.querySelector('#win').clientWidth === 1320 && !document.querySelector('#win').classList.contains('ins-over') && __e2e.resized > ${before}`;
      for (let i = 0; !(await evaluate(ready)); i++) {
        if (i === 400) throw new Error(`The page never reached the default width with its resize event: ${await evaluate("document.querySelector('#win').clientWidth + ' wide, ' + document.querySelector('#win').className + ', resize events: ' + __e2e.resized")}`);
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 3, y: 3 + (i % 2) });
        await sleep(50);
      }
    }
  }

  /** Changes the gh stand-in's file (a PR, who is signed in) under the lock the stand-in takes. */
  async function ghEdit(change) {
    const lock = `${ghFile}.lock`;
    for (let i = 0; ; i++) {
      try { fs.mkdirSync(lock); break; } catch { if (i > 400) throw new Error('the gh stand-in lock was never free'); await sleep(15); }
    }
    try {
      const db = JSON.parse(fs.readFileSync(ghFile, 'utf8'));
      change(db);
      // Whole and renamed, as the stand-in writes it, so a reader never sees half of it.
      fs.writeFileSync(`${ghFile}.tmp`, JSON.stringify(db));
      fs.renameSync(`${ghFile}.tmp`, ghFile);
    } finally { fs.rmdirSync(lock); }
  }

  const app = {
    dir, home, evaluate, until,
    /** Says something to the Dispatcher, as typing in the chat does. */
    say: (text) => evaluate(`await window.ide.call('chat:send', ${JSON.stringify(text)}, []); return 1;`),
    click: (selector) => evaluate(`const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('No element: ' + ${JSON.stringify(selector)}); el.click(); return 1;`),
    state: () => evaluate("return await window.ide.call('state');"),
    capture,
    /** A raw DevTools protocol call (IME composition, for one). */
    cdp: send,
    /** Presses a key as the keyboard does (trusted events to the focused element). modifiers: 2 Ctrl, 4 Meta. */
    async key(code, key, vk, modifiers = 0) {
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code, key, windowsVirtualKeyCode: vk, modifiers });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', code, key, windowsVirtualKeyCode: vk, modifiers });
    },
    /** Rests the pointer on an element, or on a point of the window, as the mouse does (trusted events, :hover included). */
    async hover(selector) {
      const p = typeof selector !== 'string' ? selector : await evaluate(`const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('No element: ' + ${JSON.stringify(selector)}); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };`);
      const x = Math.round(p.x), y = Math.round(p.y);
      await evaluate(PROBE);
      // A window that has just opened takes a move late or not at all: send it until the page has the pointer there
      // and has handed the element its mouseover (what the tooltip starts from).
      for (let i = 0; ; i++) {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        const end = Date.now() + 1500;
        while (Date.now() < end) {
          // The innermost hovered element is the one at the point: an ancestor of where the pointer was is hovered too.
          if (await evaluate(`const el = document.elementFromPoint(${x}, ${y}); return !!el && el.matches(':hover') && !el.querySelector(':hover') && __e2e.over === el;`)) return;
          await sleep(50);
        }
        if (i === 5) {
          const seen = await evaluate(`const el = document.elementFromPoint(${x}, ${y}); const d = (n) => n ? n.tagName + (n.id ? '#' + n.id : '') + '.' + String(n.className?.baseVal ?? n.className ?? '').split(' ').join('.') : 'none'; return 'at the point ' + d(el) + (el?.matches(':hover') ? ' (hovered)' : '') + ', last mouseover on ' + d(__e2e.over);`).catch(() => '');
          throw new Error(`The pointer did not reach ${JSON.stringify(selector)} at ${x},${y}: ${seen}`);
        }
        // A move a pixel aside, so the next one is a change the page cannot drop.
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x > 1 ? x - 1 : x + 1, y });
      }
    },
    /**
     * Presses the mouse on an element, moves it by (dx, dy) in `steps` moves `ms` apart, and lets go (trusted events),
     * as a drag does. `hold` keeps the button down and returns { x, y } to look at the row mid-drag; `release` lets go.
     * `ready`, a page expression, is waited for before letting go (or returning), moving again if the page has not
     * seen the moves yet.
     */
    async drag(selector, dx, { dy = 0, steps = 3, ms = 16, hold = false, ready = null } = {}) {
      // The pointer rests on the element first, and the press waits until the element stays where it was measured and
      // is the one at that point: a list can still shift as the pointer arrives (a macOS runner moved a row by 15px).
      const where = () => evaluate(`const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('No element: ' + ${JSON.stringify(selector)}); const r = el.getBoundingClientRect(); const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2); return { x, y, hit: !!document.elementFromPoint(x, y)?.closest(${JSON.stringify(selector)}) };`);
      await evaluate(PROBE);
      let p = await where();
      for (let i = 0; ; i++) {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
        await sleep(100);
        const q = await where();
        if (q.hit && q.x === p.x && q.y === p.y) break;
        if (i === 40) throw new Error(`The press for ${selector} would land on another element`);
        p = q;
      }
      const x0 = p.x, y0 = p.y;
      // What the page saw of the drag, for the message when it never gets there.
      if (ready) await evaluate(`if (!window.__drag) { window.__drag = []; for (const t of ['pointerdown', 'scroll', 'click', 'focusin', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture', 'dragstart', 'mousedown', 'mousemove']) window.addEventListener(t, (e) => { window.__drag.push([t, Math.round(e.clientX), e.button, e.buttons, e.pointerType ?? '', e.isPrimary ?? '', e.ctrlKey, String(e.target?.className ?? '').slice(0, 24), Math.round(e.clientY), e.defaultPrevented].join(' ')); }, true); } window.__drag.length = 0; return 1;`);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', buttons: 1, clickCount: 1 });
      for (let i = 1; i <= steps; i++) {
        await sleep(ms);
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x0 + (dx * i) / steps), y: Math.round(y0 + (dy * i) / steps), button: 'left', buttons: 1 });
      }
      const at = { x: Math.round(x0 + dx), y: Math.round(y0 + dy) };
      // A window that is not on screen hands moves to the page only when it draws a frame, which can be late (macOS
      // runners draw none for a while): while `ready` is not true yet, move again, ending where the drag ends.
      if (ready) {
        for (const end = Date.now() + 8000; !(await evaluate(`return !!(${ready});`)); ) {
          if (Date.now() > end) throw new Error(`The drag on ${selector} never reached: ${ready} | ${await evaluate('return (window.__drag ?? []).filter((x, i, all) => i < 12 || i >= all.length - 4).join(" / ") + " / scroll " + document.querySelector("#chat-ins .ins-list")?.scrollTop + " sel " + (document.querySelector("#chat-ins .sel, #chat-ins [aria-current=true]")?.className ?? "-") + " rowTop " + Math.round(document.querySelector("#chat-ins .res")?.getBoundingClientRect().top) + " / row: " + (document.querySelector(".swiping")?.className ?? "no .swiping");')}`);
          await sleep(100);
          await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x + (dx < 0 ? 1 : -1), y: at.y, button: 'left', buttons: 1 });
          await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at, button: 'left', buttons: 1 });
        }
      }
      if (!hold) await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, button: 'left', buttons: 0, clickCount: 1 });
      // A held drag rests before it is let go, so the last moves (the ones made again above, a pixel apart in a
      // moment) are not taken for a flick: it returns once 150 ms have passed in the page since the page got the last
      // move, however late the moves reached it.
      else await until('performance.now() - __e2e.movedAt >= 150', `the drag on ${selector} at rest`, 10_000);
      return at;
    },
    release: (at) => send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, button: 'left', buttons: 0, clickCount: 1 }),
    /** Sets the page's size, as resizing the window does. */
    async size(width, height = 900) {
      await evaluate(PROBE);
      const before = await evaluate("return { n: __e2e.resized, same: innerWidth === " + width + " && innerHeight === " + height + " };");
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await until(`window.innerWidth === ${width} && window.innerHeight === ${height}`, `the page at ${width}×${height}`);
      // The layout follows the resize event, which comes with the page's next frame. A window off screen may draw
      // that frame only at its next input (which brings the event); the wait for it is then given up without a
      // failure, as no input is made here (it would move the pointer under the test).
      if (!before.same) await until(`__e2e.resized > ${before.n}`, 'the resize event', 3000).catch(() => {});
    },
    workerLog: (wid) => evaluate(`return (await window.ide.call('worker:log', ${JSON.stringify(wid)})).items.map((x) => x.text).join('\\n');`),
    gh: () => JSON.parse(fs.readFileSync(ghFile, 'utf8')),
    /** Changes one PR in the stand-in's file (CI, review, conflicts), under the lock the stand-in takes. */
    ghPr: (url, fields) => ghEdit((db) => { db.prs[url] = { state: 'OPEN', mergeable: 'MERGEABLE', reviewDecision: 'APPROVED', checks: [], ...db.prs[url], ...fields }; }),
    /** Changes the stand-in's file: `change` gets its contents to change in place. */
    ghEdit,
    /** Saves a picture of the window, for looking at a screen while writing a test. */
    async shot(file, width = 1440, height = 900) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await until(`window.innerWidth === ${width} && window.innerHeight === ${height}`, `the page at ${width}×${height}`);
      const m = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(file, Buffer.from(m.result.data, 'base64'));
    },
    /**
     * Keeps what the window shows in `out` after a failure: a picture, the page's DOM, the error and the app's logs.
     * Each part is on its own, with a time limit, so a window that stopped answering still leaves its logs.
     */
    async keep(out, err) {
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, 'error.txt'), String(err?.stack ?? err));
      try {
        const m = await within(capture(), 10_000, 'the screenshot');
        if (m.result?.data) fs.writeFileSync(path.join(out, 'screenshot.png'), Buffer.from(m.result.data, 'base64'));
      } catch (e) { fs.writeFileSync(path.join(out, 'screenshot.txt'), String(e.message)); }
      try {
        fs.writeFileSync(path.join(out, 'page.html'), await within(evaluate('document.documentElement.outerHTML'), 10_000, 'the page'));
      } catch (e) { fs.writeFileSync(path.join(out, 'page.txt'), String(e.message)); }
      copyLogs(dir, home, out);
      return out;
    },
    /**
     * Opens the quick message box the way a launcher would: a second launch with --quick, which the running app
     * takes over. Returns the box's own page to evaluate in, wait on and take a picture of.
     */
    async openQuick() {
      const env = { ...process.env, OMA_FAKE_AGENT: '1', OMA_DATA_DIR: data, OMA_GH_STUB: path.join(here, 'gh-stub.mjs'), OMA_E2E_GH: ghFile };
      const second = spawn(electron, ['.', '--quick'], { cwd: root, stdio: 'ignore', env });
      await new Promise((r) => { second.once('exit', r); setTimeout(() => { second.kill('SIGKILL'); r(); }, 15_000); });
      const end = Date.now() + 15_000;
      for (;;) {
        const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
        const page = pages.find((p) => p.type === 'page' && p.url.endsWith('quick.html'));
        if (page) { quick = await attach(page.webSocketDebuggerUrl); break; }
        if (Date.now() > end) throw new Error('The quick message box did not open.');
        await sleep(200);
      }
      await quick.until("!!document.getElementById('q') && document.getElementById('q').placeholder !== ''", 'the quick box with its texts');
      return quick;
    },
    /**
     * Drives the window's page again after it was replaced (it died and the app loaded it again): connects to the
     * page that answers and waits until `ready` is true there (by default, until it has drawn the window).
     */
    async reconnect(ready = "!!document.querySelector('#chat-ins .seg')", timeoutMs = 20_000) {
      for (const p of waiting.values()) p({});
      waiting.clear();
      try { ws.close(); } catch { /* closed */ }
      const end = Date.now() + timeoutMs;
      for (;;) {
        try {
          const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
          const page = pages.find((p) => p.type === 'page' && p.url.endsWith('index.html'));
          if (page) {
            try { ws.close(); } catch { /* closed */ }
            // Held as `ws` at once, so a socket that never opens is closed by the next try or by stop().
            const next = ws = new WebSocket(page.webSocketDebuggerUrl);
            await new Promise((r, j) => { next.addEventListener('open', r); next.addEventListener('error', j); });
            next.addEventListener('message', onMessage);
            if (await Promise.race([evaluate(`return !!(${ready});`), sleep(2000).then(() => false)]).catch(() => false)) return;
          }
        } catch { /* not back yet */ }
        if (Date.now() > end) throw new Error('The window did not come back.');
        await sleep(250);
      }
    },
    /**
     * Ends the app and starts it again on the same profile, as quitting and opening it does, then drives the new
     * window once it is drawn. What the app saved is what it finds; wait for it on disk before calling this.
     */
    async restart() {
      try { quick?.close(); } catch { /* closed */ }
      quick = null;
      await endApp();
      child = startApp();
      try {
        await app.reconnect(undefined, 40_000);
        await widen();
      } catch (e) {
        // As at launch: a new app that never came up is not left running.
        child.kill('SIGKILL');
        throw Object.assign(e, { dir, home });
      }
    },
    /**
     * Runs the app once more with other arguments, for a start that does its work and quits by itself
     * (`--state-v1`), and gives its exit code. The app is ended first unless `beside` asks for it to stay, as when
     * someone starts it a second time; restart() opens it again afterwards.
     */
    async once(more, { beside = false } = {}) {
      if (!beside) {
        try { quick?.close(); } catch { /* closed */ }
        quick = null;
        await endApp();
      }
      const c = startApp(more);
      return new Promise((done, fail) => {
        const hung = setTimeout(() => { c.kill('SIGKILL'); fail(Object.assign(new Error(`The app started with ${more.join(' ')} did not quit.`), { dir, home })); }, 30_000);
        c.once('exit', (code) => { clearTimeout(hung); done(code); });
      });
    },
    async stop() {
      try { quick?.close(); } catch { /* closed */ }
      try { ws.close(); } catch { /* closed */ }
      // A quit that hangs is ended for good, so nothing outlives the test.
      await endApp();
      for (let i = 0; i < 5; i++) { try { fs.rmSync(dir, { recursive: true, force: true }); break; } catch { await sleep(300); } }
    },
  };
  return app;
}
