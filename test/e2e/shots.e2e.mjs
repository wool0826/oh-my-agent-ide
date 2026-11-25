// End-to-end flow for a report's screenshots (T-0102): the images a Worker names on FILE: lines show as before/after
// thumbnails on its result card and open at full size over the window. Run with `npm run e2e`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { launch } from './harness.mjs';

function flow(name, opts, fn) {
  test(name, { timeout: 120_000 }, async () => {
    const app = await launch(opts);
    try { await fn(app); } finally { await app.stop(); }
  });
}

const SHOT = '#ws-thread .bub.wk .shots .shot';
const DLG = '#dlg:not([hidden]) .shot-view';

flow('a report\'s screenshots show as before/after thumbnails that open at full size', {}, async (app) => {
  // A real picture of the window as both shots, written where a Worker would leave them, and a note that stays a
  // file link. (A second capture of an unchanged page waits for a frame that never comes.)
  const dir = path.join(app.home, 'shots');
  fs.mkdirSync(dir);
  const before = path.join(dir, 'card-before.png'), after = path.join(dir, 'card-after.png'), note = path.join(dir, 'notes.md');
  const png = Buffer.from((await app.cdp('Page.captureScreenshot', { format: 'png' })).result.data, 'base64');
  fs.writeFileSync(before, png);
  fs.writeFileSync(after, png);
  fs.writeFileSync(note, 'notes');
  const gone = path.join(dir, 'inbox-after.png');

  // The report names the after shot first; the card still puts the before one ahead of it.
  await app.say(['@fake task - Polish the card', '@@fake result Polished the card.', `@@fake file ${after}`, `@@fake file ${note}`, `@@fake file ${before}`, `@@fake file ${gone}`, '@@fake file shots/rel-after.png'].join('\n'));
  await app.until("window.ide.call('state').then((s) => s.tasks.some((t) => t.status === 'done'))", 'the task done');
  await app.click('button[data-v="worker"]');
  await app.until("!!document.querySelector('#wk-list .wrow [data-action=\"select-worker\"]')", 'the Worker in the list');
  await app.click('#wk-list .wrow [data-action="select-worker"]');
  await app.until(`document.querySelectorAll('${SHOT}').length === 3`, 'three thumbnails on the result card');
  assert.deepEqual(await app.evaluate(`[...document.querySelectorAll('${SHOT}')].map((b) => b.innerText.trim())`), ['Before · card', 'After · card', 'After · inbox']);
  // Images are thumbnails, not file links; the note still is one, and so is an image named by a relative path.
  assert.deepEqual(await app.evaluate("[...document.querySelectorAll('#ws-thread .bub.wk .rep-l a')].map((a) => a.innerText.trim())"), ['notes.md', 'rel-after.png']);
  await app.until(`[...document.querySelectorAll('${SHOT}:not(.broken) img')].filter((i) => i.complete && i.naturalWidth > 0).length === 2`, 'both pictures loaded from disk');
  // A file that is not there keeps its label, without a broken picture.
  await app.until(`document.querySelectorAll('${SHOT}.broken').length === 1 && document.querySelector('${SHOT}.broken').innerText.includes('inbox')`, 'the missing file marked');

  // A click opens the picture at full size, with the report's other shots a step away.
  await app.evaluate(`document.querySelector('${SHOT}:nth-child(2)').focus()`);
  await app.click(`${SHOT}:nth-child(2)`);
  await app.until(`!!document.querySelector('${DLG}') && document.querySelector('${DLG} .shot-img img').complete`, 'the after shot opened');
  const full = await app.evaluate(`const i = document.querySelector('${DLG} .shot-img img'); return { title: document.querySelector('#shot-t').textContent, w: i.naturalWidth, src: decodeURIComponent(i.src), pressed: document.querySelector('${DLG} [aria-pressed="true"]')?.textContent };`);
  // The width a PNG file gives in its header.
  const width = fs.readFileSync(after).readUInt32BE(16);
  assert.equal(full.title, 'After · card');
  assert.equal(full.pressed, 'After · card');
  assert.equal(full.w, width);
  assert.ok(full.src.endsWith(after), full.src);
  // Over the window and fitted inside it: nothing of the picture is cut off.
  const fit = await app.evaluate(`const b = document.querySelector('${DLG} .shot-img').getBoundingClientRect(), r = document.querySelector('${DLG} .shot-img img').getBoundingClientRect(); return { fixed: getComputedStyle(document.querySelector('${DLG}')).position, inside: r.width > 0 && r.left >= b.left - 1 && r.right <= b.right + 1 && r.top >= b.top - 1 && r.bottom <= b.bottom + 1 };`);
  assert.deepEqual(fit, { fixed: 'fixed', inside: true });

  await app.key('ArrowLeft', 'ArrowLeft', 37);
  await app.until("document.querySelector('#shot-t')?.textContent === 'Before · card'", 'the before shot by the left arrow');
  await app.click(`${DLG} [data-action="shot-pick"][data-i="1"]`);
  await app.until("document.querySelector('#shot-t')?.textContent === 'After · card'", 'the after shot from its switch');

  // Escape closes it and gives the focus back to the thumbnail it was opened from.
  await app.evaluate(`document.querySelector('${DLG} [data-action="shot-close"].btn').focus()`);
  await app.key('Escape', 'Escape', 27);
  await app.until("document.querySelector('#dlg').hidden", 'the picture closed');
  await app.until(`document.activeElement?.matches('${SHOT}') && document.activeElement.dataset.path.endsWith('card-after.png')`, 'the focus back on the thumbnail');
});
