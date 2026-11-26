// End-to-end flows for chat events (T-0140, option C): every event is a one-line row, and a burst of them folds into one
// summary row that counts them by kind. What needs the user stays outside the fold. Run with `npm run e2e`.
import assert from 'node:assert/strict';
import { flow } from './harness.mjs';

const T0 = Date.now() - 10 * 60_000;
const at = (s) => new Date(T0 + s * 1000).toISOString();
const ev = (id, s, e, kind = 'event', text = `${e.k} line`) => ({ id, ts: at(s), kind, text, ...(e.task ? { ref: e.task } : {}), ev: e });
const LONG = 'Stepper fix 2: keep the plan, keep done marks, say what follow-ups do, and write progress as sentences';

/** The mock-up's burst after a short exchange: a merge and the start it caused, four more, a failure and a usage limit. */
const STATE = JSON.stringify({
  version: 2, counters: { worker: 17, task: 140 }, tasks: [], sealed: { chat: 0, tasks: 0 },
  chat: [
    { id: 'u1', ts: at(-20), kind: 'user', text: 'Merge #203' },
    { id: 'd1', ts: at(-19), kind: 'dispatcher', text: 'Queued the merge.' },
    ev('m', 0, { k: 'merged', task: 'T-0136', worker: 'W-05', title: LONG, pr: 203 }, 'event', `${LONG}: PR merged, branch cleaned up`),
    ev('s', 1, { k: 'started', task: 'T-0140', worker: 'W-17', title: 'Fix empty turns after a usage limit', dep: 'T-0136' }),
    ev('c', 12, { k: 'ci', task: 'T-0135', worker: 'W-09', title: 'Show decision cards as one line', n: 1, max: 3 }),
    ev('r', 21, { k: 'review', task: 'T-0134', worker: 'W-12', title: 'Swap the memo icon', n: 2 }),
    ev('y', 29, { k: 'memory', title: 'PR titles and bodies in English' }),
    ev('i', 33, { k: 'stalled', task: 'T-0138', worker: 'W-11', title: 'Tidy the cost in the Worker header', n: 12 }),
    ev('f', 46, { k: 'failed', task: 'T-0133', worker: 'W-08', title: 'Update the visual baselines' }, 'error', 'W-08 could not finish "Update the visual baselines". Timed out.'),
    ev('l', 54, { k: 'limitPaused', note: '23:40' }, 'event', 'Every account is at its usage limit. This goes out when it resets at 23:40.'),
  ],
}, null, 2);

const BLK = '#chat-thread .evblk';
const HEAD = `${BLK} .evs-h`;

flow('a burst of events folds into one summary row with counts by kind; failures and limits stay outside it', {
  files: { 'data/state.json': STATE },
}, async (app) => {
  await app.until(`!!document.querySelector('${HEAD}')`, 'the summary row');
  // Folded: the count, the time span and one icon per kind with its number; no rows inside.
  assert.equal(await app.evaluate(`document.querySelector('${HEAD}').getAttribute('aria-expanded')`), 'false');
  assert.match(await app.evaluate(`document.querySelector('${HEAD} b').innerText`), /^6 events$/);
  assert.match(await app.evaluate(`document.querySelector('${HEAD} .evs-at').innerText`), /^\d\d:\d\d(–\d\d:\d\d)?$/);
  const counts = JSON.parse(await app.evaluate(`return JSON.stringify([...document.querySelectorAll('${HEAD} .evn')].map((n) => [n.querySelector('[role="img"]').getAttribute('aria-label'), n.innerText.trim()]));`));
  assert.deepEqual(counts, [['PR merged', '1'], ['Started', '1'], ['CI fixing', '1'], ['Review comments', '1'], ['Saved to memory', '1'], ['Stalled', '1']]);
  assert.equal(await app.evaluate(`document.querySelectorAll('${BLK} .evs-rows').length`), 0);
  // Outside the fold: the failure and the usage limit, as rows.
  const pinned = JSON.parse(await app.evaluate(`return JSON.stringify([...document.querySelectorAll('${BLK} .evs.pin .evrow')].map((r) => [r.dataset.ev, r.innerText.replace(/\\s+/g, ' ').trim()]));`));
  assert.deepEqual(pinned.map((p) => p[0]), ['failed', 'limitPaused']);
  assert.match(pinned[0][1], /^T-0133 Update the visual baselines W-08 Failed \d\d:\d\d$/);
  assert.match(pinned[1][1], /^All accounts Until 23:40 \d\d:\d\d$/);

  // Enter opens it from the keyboard: the rows, with the start under the merge that caused it.
  await app.evaluate(`document.querySelector('${HEAD}').focus(); return 1;`);
  // A key down with its text, as a keyboard sends it: what a button takes as a click.
  await app.cdp('Input.dispatchKeyEvent', { type: 'keyDown', code: 'Enter', key: 'Enter', windowsVirtualKeyCode: 13, text: String.fromCharCode(13) });
  await app.cdp('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Enter', key: 'Enter', windowsVirtualKeyCode: 13 });
  await app.until(`document.querySelector('${HEAD}')?.getAttribute('aria-expanded') === 'true'`, 'the burst opened by Enter');
  assert.equal(await app.evaluate(`document.activeElement === document.querySelector('${HEAD}')`), true, 'the focus stays on the summary row');
  const rows = JSON.parse(await app.evaluate(`return JSON.stringify([...document.querySelectorAll('${BLK} .evs-rows > *')].map((r) => r.classList.contains('evpair') ? [...r.querySelectorAll('.evrow')].map((x) => x.dataset.ev) : r.dataset.ev));`));
  assert.deepEqual(rows, [['merged', 'started'], 'ci', 'review', 'memory', 'stalled']);
  assert.match(await app.evaluate(`document.querySelector('${BLK} .evpair .evrow').innerText.replace(/\\s+/g, ' ')`), /^T-0136 Stepper fix 2.* W-05 #203 Merged \d\d:\d\d$/);
  assert.match(await app.evaluate(`document.querySelector('${BLK} .evrow[data-ev="ci"] .pill').innerText`), /^CI 1\/3$/);
  // A long title is cut to one line with an ellipsis; the whole sentence is its tooltip.
  const cut = JSON.parse(await app.evaluate(`const t = document.querySelector('${BLK} .evpair .evt'); return JSON.stringify([getComputedStyle(t).textOverflow, t.scrollWidth > t.clientWidth, t.dataset.tip]);`));
  assert.deepEqual(cut, ['ellipsis', true, `${LONG}: PR merged, branch cleaned up`]);

  // Space folds it again.
  await app.evaluate(`document.querySelector('${HEAD}').focus(); return 1;`);
  await app.key('Space', ' ', 32);
  await app.until(`document.querySelector('${HEAD}')?.getAttribute('aria-expanded') === 'false' && !document.querySelector('${BLK} .evs-rows')`, 'the burst folded by Space');

  // A narrow window: open, nothing runs out sideways.
  await app.click(HEAD);
  await app.until(`!!document.querySelector('${BLK} .evs-rows')`, 'the burst opened by a click');
  await app.size(900, 760);
  await app.until(`const th = document.querySelector('#chat-thread'), b = document.querySelector('${BLK}').getBoundingClientRect(), r = th.getBoundingClientRect();
    return th.scrollWidth <= th.clientWidth && b.right <= r.right && b.left >= r.left;`, 'the block inside the thread at 900px');
});

flow('a few events stay rows, in time order, with nothing folded', {
  files: {
    'data/state.json': JSON.stringify({
      version: 2, counters: { worker: 2, task: 2 }, tasks: [], sealed: { chat: 0, tasks: 0 },
      chat: [
        { id: 'u1', ts: at(-5), kind: 'user', text: 'Hello' },
        ev('a', 0, { k: 'merged', task: 'T-0001', title: 'First', pr: 1 }),
        ev('b', 1, { k: 'started', task: 'T-0002', worker: 'W-02', title: 'Second', dep: 'T-0001' }),
      ],
    }),
  },
}, async (app) => {
  await app.until("!!document.querySelector('#chat-thread .evs .evpair')", 'the pair of rows');
  assert.equal(await app.evaluate("document.querySelectorAll('#chat-thread .evs-h').length"), 0);
  assert.deepEqual(JSON.parse(await app.evaluate("return JSON.stringify([...document.querySelectorAll('#chat-thread .evrow')].map((r) => r.dataset.ev));")), ['merged', 'started']);
  assert.equal(await app.evaluate("document.querySelector('#chat-thread .evpair .evrow + .evrow [role=\"img\"]').getAttribute('aria-label')"), 'Then');
});
