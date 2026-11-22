// Starts the built app on an empty profile with fake agents and a stand-in for gh, and drives its window over
// the Chrome DevTools Protocol. Nothing here uses an account, a model or the network.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const electron = createRequire(import.meta.url)('electron'); // the path of the Electron executable
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
 * (each at https://github.com/o/<name>); `gh` seeds the stand-in's file (prs, issues).
 */
export async function launch({ settings = {}, repos = [], gh = {} } = {}) {
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

  const port = await freePort();
  const log = fs.openSync(path.join(dir, 'app.log'), 'w');
  const child = spawn(electron, ['.', `--remote-debugging-port=${port}`, '--hidden'], {
    cwd: root, stdio: ['ignore', log, log],
    env: { ...process.env, OMA_FAKE_AGENT: '1', OMA_DATA_DIR: data, OMA_GH_STUB: path.join(here, 'gh-stub.mjs'), OMA_E2E_GH: ghFile, ELECTRON_ENABLE_LOGGING: '1' },
  });

  let ws;
  const deadline = Date.now() + 40_000;
  for (;;) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = pages.find((p) => p.type === 'page' && p.url.endsWith('index.html'));
      if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); }); break; }
    } catch { /* not up yet */ }
    if (Date.now() > deadline) { child.kill(); throw new Error(`The app did not start. Log: ${fs.readFileSync(path.join(dir, 'app.log'), 'utf8').slice(-2000)}`); }
    await sleep(250);
  }
  let id = 0;
  const waiting = new Map();
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });

  /** Evaluates an expression (or the body of an async function when it has `await` or `return`) in the page. */
  async function evaluate(js) {
    const expression = /\b(await|return)\b/.test(js) ? `(async () => { ${js} })()` : js;
    const m = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (m.result?.exceptionDetails) throw new Error(`In the page: ${m.result.exceptionDetails.exception?.description ?? m.result.exceptionDetails.text}\n${js}`);
    return m.result?.result?.value;
  }

  /** Waits until the expression is truthy in the page and returns its value. */
  async function until(js, what = js, timeoutMs = 20_000) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const v = await evaluate(js);
      if (v) return v;
      if (Date.now() > end) {
        const state = await evaluate("document.querySelector('#side')?.innerText + ' | ' + (document.querySelector('.inspector:not([hidden])')?.innerText ?? '').slice(0, 600)").catch(() => '');
        throw new Error(`Timed out waiting for: ${what}\nOn screen: ${state}`);
      }
      await sleep(150);
    }
  }

  // The first state has arrived and the window is drawn. If it never is, the app must not be left running:
  // a child still alive keeps the test process from ending.
  try {
    await until("!!document.querySelector('#chat-ins .segc')", 'the main window');
  } catch (e) {
    const page = await evaluate("document.readyState + ' | ' + location.href + ' | ide=' + typeof window.ide + ' | body=' + document.body.innerText.slice(0, 300)").catch((x) => String(x));
    try { ws.close(); } catch { /* closed */ }
    child.kill('SIGKILL');
    throw new Error(`${e.message}\nPage: ${page}\nApp log: ${fs.readFileSync(path.join(dir, 'app.log'), 'utf8').slice(-3000)}`);
  }

  return {
    dir, evaluate, until,
    /** Says something to the Dispatcher, as typing in the chat does. */
    say: (text) => evaluate(`await window.ide.call('chat:send', ${JSON.stringify(text)}, []); return 1;`),
    click: (selector) => evaluate(`const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('No element: ' + ${JSON.stringify(selector)}); el.click(); return 1;`),
    state: () => evaluate("return await window.ide.call('state');"),
    workerLog: (wid) => evaluate(`return (await window.ide.call('worker:log', ${JSON.stringify(wid)})).items.map((x) => x.text).join('\\n');`),
    gh: () => JSON.parse(fs.readFileSync(ghFile, 'utf8')),
    async stop() {
      try { ws.close(); } catch { /* closed */ }
      child.kill();
      // A quit that hangs is ended for good, so nothing outlives the test.
      await new Promise((r) => { child.once('exit', r); setTimeout(() => { child.kill('SIGKILL'); r(); }, 3000); });
      for (let i = 0; i < 5; i++) { try { fs.rmSync(dir, { recursive: true, force: true }); break; } catch { await sleep(300); } }
    },
  };
}
