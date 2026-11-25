// End-to-end flows for crashes (T-0098): the window's page dying and coming back, and what a run that did not quit
// leaves for the next start. Run with `npm run e2e`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { flow } from './harness.mjs';

flow('the window comes back with the same state after its page dies', {}, async (app) => {
  const marker = JSON.parse(fs.readFileSync(path.join(app.home, 'data', 'running.json'), 'utf8'));
  assert.equal(typeof marker.pid, 'number');
  assert.equal(await app.evaluate("return await window.ide.call('crash:lastRun');"), null);

  await app.say('@fake say Before the crash.');
  await app.until("document.querySelector('#chat-thread')?.innerText.includes('Before the crash.')", 'the reply before the crash');

  // The page's process dies (no answer comes for this call), and a page without this mark is the one loaded again.
  await app.evaluate('window.__beforeCrash = 1');
  void app.cdp('Page.crash').catch(() => {});
  await app.reconnect("!window.__beforeCrash && !!document.querySelector('#chat-ins .seg')");
  await app.until("document.querySelector('#chat-thread')?.innerText.includes('Before the crash.')", 'the same chat after the page came back');
  await app.until(`return (await window.ide.call('diag:text')).includes('renderer crashed');`, 'the crash in the report');
});

flow('a run that did not quit is reported once at the next start, with the crash log in the report', {
  files: {
    'data/running.json': JSON.stringify({ pid: 1, startedAt: '2026-11-24T10:00:00.000Z', version: '0.0.0', crash: { at: '2026-11-24T10:05:00.000Z', message: 'Error: boom' } }),
    'data/crash.log': '2026-11-24T10:05:00.000Z exception Error: boom\n    at explode (main.js:1:1)\n',
  },
}, async (app) => {
  const last = await app.evaluate("return await window.ide.call('crash:lastRun');");
  assert.equal(last.startedAt, '2026-11-24T10:00:00.000Z');
  assert.equal(last.crash.message, 'Error: boom');
  // This run's own marker took the old one's place.
  assert.notEqual(JSON.parse(fs.readFileSync(path.join(app.home, 'data', 'running.json'), 'utf8')).pid, 1);
  const report = await app.evaluate("return await window.ide.call('diag:text');");
  assert.match(report, /\[crashes\]\n2026-11-24T10:05:00\.000Z exception Error: boom\n {4}at explode/);
});
