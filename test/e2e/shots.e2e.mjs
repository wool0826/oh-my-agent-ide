// End-to-end flow for a report's screenshots (T-0102): the images a Worker names on FILE: lines show as before/after
// thumbnails on its result card and open at full size over the window. Run with `npm run e2e`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { flow } from './harness.mjs';

const SHOT = '#ws-thread .bub.wk .shots .shot';
const DLG = '#dlg:not([hidden]) .shot-view';

/**
 * What lies at the window's top bar under an open dialog (T-0147): every toolbar and sidebar-top button's centre and
 * the bar's corners hit the dialog's layer, which cancels the drag regions there (Electron hit-tests those before the
 * page), and the panel starts below the bar, clear of the caption buttons and the traffic lights.
 */
const COVERED = `const bar = document.querySelector('.toolbar').getBoundingClientRect(), w = innerWidth;
  const pts = [[1, 1], [w - 2, 1], [1, bar.bottom - 2], [w - 2, bar.bottom - 2], [w / 2, bar.top + bar.height / 2]];
  for (const el of document.querySelectorAll('.toolbar button, .lights, nav button')) {
    const r = el.getBoundingClientRect();
    if (r.width && r.height && r.top < bar.bottom) pts.push([r.left + r.width / 2, r.top + r.height / 2], [r.left + 1, r.top + 1], [r.right - 2, r.top + 1]);
  }
  const region = (el) => { for (let n = el; n; n = n.parentElement) { const v = getComputedStyle(n).getPropertyValue('-webkit-app-region') || getComputedStyle(n).getPropertyValue('app-region'); if (v === 'drag' || v === 'no-drag') return v; } return 'none'; };
  const bad = pts.map(([x, y]) => [Math.round(x), Math.round(y)]).map(([x, y]) => { const el = document.elementFromPoint(x, y); return { x, y, el: el ? el.tagName + '.' + el.className : null, inside: !!el && document.querySelector('#dlg').contains(el), region: el ? region(el) : '' }; }).filter((p) => !p.inside || p.region !== 'no-drag');
  return { bad, panelBelowBar: document.querySelector('#dlg .dlg').offsetTop >= bar.bottom };`;

flow('a report\'s screenshots show as before/after thumbnails that open at full size', {}, async (app) => {
  // A real picture of the window as both shots, written where a Worker would leave them, and a note that stays a
  // file link. (A second capture of an unchanged page waits for a frame that never comes.)
  const dir = path.join(app.home, 'shots');
  fs.mkdirSync(dir);
  const before = path.join(dir, 'card-before.png'), after = path.join(dir, 'card-after.png'), note = path.join(dir, 'notes.md');
  const png = Buffer.from((await app.capture()).result.data, 'base64');
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
  // Two screens: card with its before next to its after, inbox with only an after (its file is gone).
  assert.deepEqual(await app.evaluate("[...document.querySelectorAll('#ws-thread .bub.wk .shot-set')].map((s) => [s.querySelector('.shot-row b')?.innerText, [...s.querySelectorAll('.shot-h')].map((h) => h.innerText).join('/')])"), [['card', 'Before/After'], ['inbox', 'After']]);
  assert.deepEqual(await app.evaluate(`[...document.querySelectorAll('#ws-thread .bub.wk .shot-set:first-child .shot')].map((b) => b.getAttribute('aria-label'))`), ['Before · card, card-before.png', 'After · card, card-after.png']);
  // Images are thumbnails, not file links; the note still is one, and so is an image named by a relative path.
  assert.deepEqual(await app.evaluate("[...document.querySelectorAll('#ws-thread .bub.wk .rep-l a')].map((a) => a.innerText.trim())"), ['notes.md', 'rel-after.png']);
  await app.until(`[...document.querySelectorAll('${SHOT}:not(.broken) img')].filter((i) => i.complete && i.naturalWidth > 0).length === 2`, 'both pictures loaded from disk');
  // A file that is not there keeps its label, without a broken picture.
  await app.until(`document.querySelectorAll('${SHOT}.broken').length === 1 && document.querySelector('${SHOT}.broken').dataset.path.endsWith('inbox-after.png')`, 'the missing file marked');

  // A click opens the picture at full size, with the report's other shots a step away.
  const AFTER = `${SHOT}[data-path$="card-after.png"]`;
  await app.evaluate(`document.querySelector('${AFTER}').focus()`);
  await app.click(AFTER);
  await app.until(`!!document.querySelector('${DLG}') && document.querySelector('${DLG} .shot-img img').complete`, 'the after shot opened');
  const full = await app.evaluate(`const i = document.querySelector('${DLG} .shot-img img'); return { title: document.querySelector('#shot-t').textContent, w: i.naturalWidth, src: decodeURIComponent(i.src), pressed: [...document.querySelectorAll('${DLG} [aria-pressed="true"]')].map((b) => b.textContent || b.getAttribute('aria-label')) };`);
  // The width a PNG file gives in its header.
  const width = fs.readFileSync(after).readUInt32BE(16);
  assert.equal(full.title, 'After · card');
  // The switch of its version, and its place in the strip of the report's shots.
  assert.deepEqual(full.pressed, ['After', 'After · card']);
  assert.equal(full.w, width);
  assert.ok(full.src.endsWith(after), full.src);
  // Over the window and fitted inside it: nothing of the picture is cut off.
  const fit = await app.evaluate(`const b = document.querySelector('${DLG} .shot-img').getBoundingClientRect(), r = document.querySelector('${DLG} .shot-img img').getBoundingClientRect(); return { fixed: getComputedStyle(document.querySelector('${DLG}')).position, inside: r.width > 0 && r.left >= b.left - 1 && r.right <= b.right + 1 && r.top >= b.top - 1 && r.bottom <= b.bottom + 1 };`);
  assert.deepEqual(fit, { fixed: 'fixed', inside: true });
  assert.deepEqual(await app.evaluate(COVERED), { bad: [], panelBelowBar: true });

  await app.key('ArrowLeft', 'ArrowLeft', 37);
  await app.until("document.querySelector('#shot-t')?.textContent === 'Before · card'", 'the before shot by the left arrow');
  await app.click(`${DLG} [data-action="shot-pick"][data-i="1"]`);
  await app.until("document.querySelector('#shot-t')?.textContent === 'After · card'", 'the after shot from the strip');
  await app.click(`${DLG} [data-action="shot-axis"][data-axis="role"][data-v="before"]`);
  await app.until("document.querySelector('#shot-t')?.textContent === 'Before · card'", 'the before shot from its switch');
  await app.click(`${DLG} [data-action="shot-axis"][data-axis="role"][data-v="after"]`);
  await app.until("document.querySelector('#shot-t')?.textContent === 'After · card'", 'the after shot again');

  // Escape closes it and gives the focus back to the thumbnail it was opened from.
  await app.evaluate(`document.querySelector('${DLG} [data-action="shot-close"].btn').focus()`);
  await app.key('Escape', 'Escape', 27);
  await app.until("document.querySelector('#dlg').hidden", 'the picture closed');
  await app.until(`document.activeElement?.matches('${SHOT}') && document.activeElement.dataset.path.endsWith('card-after.png')`, 'the focus back on the thumbnail');

  // A real click on a toolbar button behind the open picture lands on the backdrop: it closes the picture, and the
  // button's own action (the command palette) does not run.
  await app.click(AFTER);
  await app.until(`!!document.querySelector('${DLG}')`, 'the picture open again');
  const at = await app.evaluate("const r = document.querySelector('#cmdk-btn').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };");
  await app.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at });
  await app.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...at, button: 'left', buttons: 1, clickCount: 1 });
  await app.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, button: 'left', buttons: 0, clickCount: 1 });
  await app.until("document.querySelector('#dlg').hidden", 'the picture closed by the backdrop');
  assert.equal(await app.evaluate("return document.querySelector('#cmdk').hidden;"), true, 'the command palette stays closed');
});

const CARD = '#chat-thread .attach[data-task]';
/** The file names the thumbnails under `root` show, in order. */
const shown = (root) => `[...document.querySelectorAll('${root} .shot[data-path]')].map((b) => b.dataset.path.split(/[\\\\/]/).pop())`;

flow('a result card shows one before/after pair of its screenshots, with switches for width and theme (T-0138)', { repos: ['demo'] }, async (app) => {
  // The 8 shots a UI task leaves (before/after × wide/narrow × dark/light), a report and a log beside them, and a PR.
  const dir = path.join(app.home, 'T-0136');
  fs.mkdirSync(dir);
  const png = Buffer.from((await app.capture()).result.data, 'base64');
  const shots = ['before', 'after'].flatMap((r) => ['wide', 'narrow'].flatMap((w) => ['dark', 'light'].map((t) => path.join(dir, `${r}-inbox-${w}-${t}.png`))));
  for (const f of shots) fs.writeFileSync(f, png);
  const report = path.join(dir, 'report.md'), log = path.join(dir, 'preflight-run-with-a-rather-long-name-2026-11-26.log');
  fs.writeFileSync(report, 'report');
  fs.writeFileSync(log, 'log');
  const url = 'https://github.com/o/demo/pull/7';
  await app.say(['@fake task demo Restyle the inbox', '@@fake write a.txt a', '@@fake commit Restyle', `@@fake pr ${url}`, '@@fake result Restyled the inbox.', ...[...shots, report, log].map((f) => `@@fake file ${f}`)].join('\n'));
  await app.until(`document.querySelectorAll('${CARD} .shot').length === 2`, 'one pair on the result card');

  // One pair, wide and dark first; the other six behind the switches, counted.
  assert.deepEqual(await app.evaluate(shown(CARD)), ['before-inbox-wide-dark.png', 'after-inbox-wide-dark.png']);
  assert.deepEqual(await app.evaluate(`[...document.querySelectorAll('${CARD} .shot-h')].map((h) => h.innerText)`), ['Before', 'After']);
  assert.deepEqual(await app.evaluate(`[...document.querySelectorAll('${CARD} .shot-row .seg')].map((g) => g.getAttribute('aria-label') + ':' + [...g.querySelectorAll('button')].map((b) => b.innerText + (b.getAttribute('aria-pressed') === 'true' ? '*' : '')).join('|'))`), ['Width:Wide*|Narrow', 'Theme:Dark*|Light']);
  assert.deepEqual(await app.evaluate(`const n = document.querySelector('${CARD} .shot-n'); return [n.innerText.trim(), n.dataset.tip];`), ['8', '8 images']);
  // The two thumbnails side by side, each half of the row.
  assert.equal(await app.evaluate(`const [a, b] = [...document.querySelectorAll('${CARD} .shot')].map((x) => x.getBoundingClientRect()); return Math.abs(a.top - b.top) < 1 && Math.abs(a.width - b.width) < 1 && a.width > 150;`), true);

  // The switches show the narrow, then the light pair, and keep the focus.
  await app.click(`${CARD} [data-action="shot-axis"][data-v="narrow"]`);
  await app.until(`${shown(CARD)}.join() === 'before-inbox-narrow-dark.png,after-inbox-narrow-dark.png'`, 'the narrow pair');
  await app.click(`${CARD} [data-action="shot-axis"][data-v="light"]`);
  await app.until(`${shown(CARD)}.join() === 'before-inbox-narrow-light.png,after-inbox-narrow-light.png'`, 'the narrow light pair');
  assert.equal(await app.evaluate('document.activeElement?.dataset.v'), 'light');

  // The other files are one-line chips; the action row has the PR chip, icon-only buttons and the cost.
  assert.deepEqual(await app.evaluate(`[...document.querySelectorAll('${CARD} .rfiles .fchip')].map((c) => [c.innerText.trim(), c.getBoundingClientRect().height])`), [['report.md', 24], ['preflight-run-w…2026-11-26.log', 24]]);
  // A chip with no remove button keeps the same room on both sides of its name (T-0142).
  const room = await app.evaluate(`return [...document.querySelectorAll('${CARD} .rfiles .fchip')].map((c) => {
    const s = getComputedStyle(c), r = c.getBoundingClientRect(), fn = c.querySelector('.fn').getBoundingClientRect();
    return [s.paddingLeft, s.paddingRight, Math.round(r.right - fn.right)];
  });`);
  room.forEach(([l, r, gap], i) => {
    assert.equal(r, l, `chip ${i} has ${l} on the left and ${r} on the right`);
    assert.ok(gap >= parseFloat(l), `chip ${i}'s name ends ${gap}px from its edge`);
  });
  const wid = (await app.state()).tasks.find((x) => x.title === 'Restyle the inbox').workerId;
  assert.deepEqual(await app.evaluate(`const r = document.querySelector('${CARD} .racts'); return [r.querySelector('.prchip').innerText.replace(/\\s+/g, ' ').trim(), [...r.querySelectorAll('button')].map((b) => [b.innerText.trim(), b.getAttribute('aria-label')])];`), ['#7 Open', [['', `Open ${wid} conversation`], ['', 'Reply']]]);
  // No file is a bare link any more.
  assert.equal(await app.evaluate(`document.querySelectorAll('${CARD} .racts [data-action="open-file"]').length`), 0);

  // A thumbnail opens the shot with the same switches, and a strip of all eight.
  await app.click(`${CARD} .shot[data-path$="after-inbox-narrow-light.png"]`);
  await app.until(`!!document.querySelector('${DLG}')`, 'the shot opened');
  assert.equal(await app.evaluate("document.querySelector('#shot-t').textContent"), 'After · inbox · Narrow · Light');
  assert.deepEqual(await app.evaluate(`[...document.querySelectorAll('${DLG} .shot-segs .seg')].map((g) => g.getAttribute('aria-label'))`), ['Version', 'Width', 'Theme']);
  assert.equal(await app.evaluate(`document.querySelectorAll('${DLG} .shot-strip button').length`), 8);
  await app.click(`${DLG} [data-action="shot-axis"][data-v="before"]`);
  await app.until("document.querySelector('#shot-t')?.textContent === 'Before · inbox · Narrow · Light'", 'the before shot');
  await app.click(`${DLG} [data-action="shot-axis"][data-v="wide"]`);
  await app.until("document.querySelector('#shot-t')?.textContent === 'Before · inbox · Wide · Light'", 'the wide shot');
  assert.equal(await app.evaluate(`document.querySelector('${DLG} .shot-strip [aria-pressed="true"]').dataset.i`), '1');
  await app.key('Escape', 'Escape', 27);
  await app.until("document.querySelector('#dlg').hidden", 'the shot closed');

  // The inbox row and the Worker's summary draw the same parts.
  await app.until("document.querySelectorAll('#chat-ins .res .shot').length === 2", 'the pair on the inbox row');
  assert.deepEqual(await app.evaluate("[...document.querySelectorAll('#chat-ins .res')].map((r) => [r.querySelectorAll('.rfiles .fchip').length, !!r.querySelector('.racts .prchip'), r.querySelectorAll('.shot-row .seg').length])"), [[2, true, 2]]);
  await app.click('button[data-v="worker"]');
  await app.until(`!!document.querySelector('#wk-list [data-action="select-worker"]')`, 'the Worker in the list');
  await app.click('#wk-list [data-action="select-worker"]');
  await app.until("!!document.querySelector('#ws-tab-summary')", 'the Summary tab');
  await app.click('#ws-tab-summary');
  await app.until("document.querySelectorAll('#ws-sum .sum-task .shot').length === 2", 'the pair on the summary');
  assert.deepEqual(await app.evaluate("const c = document.querySelector('#ws-sum .sum-task'); return [c.querySelectorAll('.rfiles .fchip').length, !!c.querySelector('.racts .prchip'), c.querySelectorAll('.shot-row .seg').length];"), [2, true, 2]);
});
