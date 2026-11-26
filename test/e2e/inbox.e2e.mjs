// End-to-end flows: Notifications: decisions and results in the list, clearing them by key, click and swipe, and Undo.
// Each flow starts the built app on its own empty profile with fake agents and a stand-in for gh. Run with `npm run e2e`.
import assert from 'node:assert/strict';
import { flow } from './harness.mjs';

flow('one name for a waiting decision, a search that finds nothing says so, and the send button waits for something to send', {}, async (app) => {
  // Nothing typed: nothing to send.
  const typeIn = (v) => app.evaluate(`const i = document.querySelector('#chat-input'); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('input', { bubbles: true })); return document.querySelector('#chat-send').disabled;`);
  assert.equal(await app.evaluate("document.querySelector('#chat-send').disabled"), true);
  assert.equal(await typeIn('   '), true);
  assert.equal(await typeIn('Hello'), false);
  assert.equal(await typeIn(''), true);
  // The sidebar, its row and the right sidebar use the same words for a decision that waits.
  await app.say(['Hello', '@fake task - Write a note', '@@fake permission npm install left-pad'].join('\n'));
  await app.until("document.querySelectorAll('#chat-ins .dec').length === 1 && !!document.querySelector('#side .drow')", 'a decision');
  const text = await app.evaluate("document.body.innerText");
  assert.ok(!/waiting for you/i.test(text), 'the old name is gone');
  assert.ok(await app.evaluate("document.querySelector('#chat-ins').innerText.includes('Needs your decision')"));
  // A decision row says who asks and what kind; a Worker row joins its parts the same way.
  assert.equal(await app.evaluate("document.querySelector('#side .drow small').textContent"), 'W-01 · Command');
  assert.equal(await app.evaluate("document.querySelector('#side .row.split small').textContent"), 'W-01 · Needs your decision');
  // Settings: a search without a match hides the panes and says so; clearing it brings them back.
  await app.click('[data-action="open-settings"]');
  const search = (v) => app.evaluate(`const i = document.getElementById('set-q'); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('input', { bubbles: true }));
    return [document.getElementById('set-none').hidden, document.querySelector('#sheet .sinner').hidden, [...document.querySelectorAll('#sheet .snav-i')].filter((b) => !b.hidden).length].join();`);
  assert.equal(await search('zzzz'), 'false,true,0');
  assert.equal(await app.evaluate("document.getElementById('set-none').textContent"), 'Nothing found');
  assert.match(await search(''), /^true,false,[1-9]/);
  // The model list never shows a bare dash for its state.
  await app.click('[data-action="pane"][data-id="models"]');
  await app.until("!document.querySelector('#set-mlist .skel')", 'the model list read');
  const state = await app.evaluate("document.getElementById('set-mlist').textContent.trim()");
  assert.ok(state.length > 1 && state !== '–', state);
});

flow('a result is cleared on its own by its ✕ or Delete and comes back with Undo, and the list answers the arrows at any width', {}, async (app) => {
  await app.say('@fake task - First one\n@@fake result One.\n@fake task - Second one\n@@fake result Two.\n@fake task - Third one\n@@fake result Three.');
  await app.until("document.querySelectorAll('#chat-ins .res').length === 3", 'three result cards');
  // The list is one Tab stop, nothing is selected, and its header says "Clear all".
  const stops = () => app.evaluate("return [...document.querySelectorAll('#chat-ins .ins-list [data-nav]')].filter((x) => x.tabIndex === 0).map((x) => x.dataset.nav);");
  assert.equal((await stops()).length, 1);
  assert.equal(await app.evaluate("document.querySelector('#chat-ins [data-action=\"clear\"][data-kind=\"result\"]').textContent"), 'Clear all');
  assert.equal(await app.evaluate("document.querySelectorAll('#chat-ins .sel, #chat-ins [aria-current=\"true\"]').length"), 0);
  // ↓ and ↑ move the focus between results; the focused one is the Tab stop and shows its ✕.
  const ids = await app.evaluate("return [...document.querySelectorAll('#chat-ins .res')].map((x) => x.dataset.nav);");
  await app.evaluate("document.querySelector('#chat-ins .res').focus(); return 1;");
  await app.key('ArrowDown', 'ArrowDown', 40);
  const focused = () => app.evaluate("return document.activeElement?.dataset.nav ?? null;");
  assert.equal(await focused(), ids[1]);
  assert.deepEqual(await stops(), [ids[1]]);
  await app.until("getComputedStyle(document.activeElement.querySelector('.row-acts')).opacity === '1'", 'the ✕ of the focused row');
  assert.equal(await app.evaluate("document.activeElement.querySelector('.row-x').dataset.tipKey"), 'Delete');
  await app.key('End', 'End', 35);
  assert.equal(await focused(), ids[2]);
  // Delete on the last one clears it alone; the focus goes to the one before it, and the toast offers Undo.
  await app.key('Delete', 'Delete', 46);
  await app.until("document.querySelectorAll('#chat-ins .res').length === 2", 'one result cleared');
  assert.equal(await focused(), ids[1]);
  assert.match(await app.evaluate("document.querySelector('.toast')?.innerText ?? ''"), /Cleared 1 result/);
  // Ctrl/Cmd+Z puts it back.
  await app.key('KeyZ', 'z', 90, process.platform === 'darwin' ? 4 : 2);
  await app.until("document.querySelectorAll('#chat-ins .res').length === 3", 'the result back');
  // The ✕ on the first one clears only that one.
  await app.click(`#chat-ins .res[data-nav="${ids[0]}"] .row-x`);
  await app.until("document.querySelectorAll('#chat-ins .res').length === 2", 'the first result cleared');
  assert.deepEqual(await app.evaluate("return [...document.querySelectorAll('#chat-ins .res')].map((x) => x.dataset.nav);"), [ids[1], ids[2]]);
  // "Clear all" clears the rest.
  await app.click('#chat-ins [data-action="clear"][data-kind="result"]');
  await app.until("document.querySelectorAll('#chat-ins .res').length === 0", 'all cleared');
  // Memos: none is selected at first; ↓ from a focused memo at the default width selects it, then the next one.
  await app.evaluate("for (const x of ['Alpha memo', 'Beta memo', 'Gamma memo']) await window.ide.call('memo:add', x); return 1;");
  await app.click('[data-action="ins-tab"][data-v="memo"]');
  await app.until("document.querySelectorAll('#chat-ins .pk').length === 3", 'three memos');
  assert.equal(await app.evaluate("document.querySelectorAll('#chat-ins .pk.sel').length"), 0);
  await app.evaluate("document.querySelector('#chat-ins .pk-c > .memo[data-nav]').focus(); return 1;");
  const first = await focused();
  assert.equal(await app.evaluate("document.querySelectorAll('#chat-ins .pk.sel').length"), 0);
  await app.key('ArrowDown', 'ArrowDown', 40);
  await app.until(`document.querySelector('#chat-ins .pk.sel > .pk-c > .memo')?.dataset.nav === '${first}'`, 'the focused memo selected');
  await app.key('ArrowDown', 'ArrowDown', 40);
  await app.until(`!!document.querySelector('#chat-ins .pk.sel') && document.querySelector('#chat-ins .pk.sel > .pk-c > .memo')?.dataset.nav !== '${first}'`, 'the next memo selected');
  assert.equal(await focused(), await app.evaluate("document.querySelector('#chat-ins .pk.sel > .pk-c > .memo').dataset.nav"));
});

flow('a Notifications row swiped sideways is cleared with Undo; a short swipe, a scroll or a decision comes back', {}, async (app) => {
  await app.say('@fake task - First one\n@@fake result One.\n@fake task - Second one\n@@fake result Two.\n@fake task - Third one\n@@fake result Three.\n@fake task - Ask one\n@@fake permission npm install a\n@@fake result Installed.');
  await app.until("document.querySelectorAll('#chat-ins .res').length === 3 && !!document.querySelector('#chat-ins .dec[data-dec]')", 'three results and a decision');
  // The list settles before each press, so it lands on the row measured: the decision's card is whole (its slot clock
  // shows once its task waits, and moved the rows under it by a line), nothing in the list is moving, and the rows
  // stood still over four looks in a row.
  const steady = async () => app.evaluate('window.__rows = null; return 1;').then(() => app.until(`const card = document.querySelector('#chat-ins .dec[data-dec]'); const clock = card?.querySelector('.dhold');
    if (card && clock?.hidden) return false;
    // A move or fade that ends (an endless one, such as a pulse, never would).
    if (document.getAnimations().some((a) => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity && document.querySelector('#chat-ins')?.contains(a.effect?.target))) { window.__rows = null; return false; }
    const now = [...document.querySelectorAll('#chat-ins .res, #chat-ins .dec')].map((x) => x.getBoundingClientRect().top).join();
    if (!window.__rows || window.__rows.at !== now) { window.__rows = { at: now, same: 0 }; return false; }
    return ++window.__rows.same >= 3;`, 'the Notifications list at rest', 20_000, "[...document.querySelectorAll('#chat-ins .res, #chat-ins .dec')].map((x) => x.className + ' ' + Math.round(x.getBoundingClientRect().top)).join(' / ') + ' | clock hidden ' + document.querySelector('#chat-ins .dec[data-dec] .dhold')?.hidden"));
  await steady();
  const ids = await app.evaluate("return [...document.querySelectorAll('#chat-ins .res')].map((x) => x.dataset.nav);");
  const w = await app.evaluate("document.querySelector('#chat-ins .res').offsetWidth");
  const row = (nav) => `#chat-ins .res[data-nav="${nav}"]`;
  const look = (nav) => app.evaluate(`const r = document.querySelector('${row(nav)}'); const u = document.querySelector('#chat-ins .swipe-under'); return { x: r ? new DOMMatrix(getComputedStyle(r).transform).m41 : null, under: u ? (u.classList.contains('armed') ? 'armed' : 'shown') : 'none', side: u?.classList.contains('right') ? 'right' : 'left' };`);
  const settled = (n) => app.until(`document.querySelectorAll('#chat-ins .res').length === ${n} && !document.querySelector('#chat-ins .swiping, #chat-ins .swipe-under')`, `${n} results at rest`).catch(async (err) => {
    throw new Error(`${err.message}
Page: ${await app.evaluate("return document.visibilityState + ', ' + document.querySelectorAll('#chat-ins .res').length + ' results, ' + (document.querySelector('#chat-ins .swiping')?.className ?? 'none swiping') + ', under ' + !!document.querySelector('#chat-ins .swipe-under');")}`);
  });
  // A short drag: the row follows and shows the red side it leaves, not yet armed; let go, it slides back.
  // Each drag waits until the page has drawn where it ends: the moves can reach a window off screen late.
  const at_ = (nav, x) => `Math.abs(new DOMMatrix(getComputedStyle(document.querySelector('${row(nav)}')).transform).m41 - (${x})) <= 1`;
  let at = await app.drag(`${row(ids[0])} .tile`, Math.round(w * 0.2), { hold: true, ready: at_(ids[0], Math.round(w * 0.2)) });
  let seen = await look(ids[0]);
  assert.ok(Math.abs(seen.x - Math.round(w * 0.2)) <= 1, JSON.stringify(seen));
  assert.equal(seen.under, 'shown');
  await app.release(at);
  await settled(3);
  assert.equal((await look(ids[0])).x, 0);
  // Past 35%: armed, and letting go clears it with the same toast and Undo as its ✕.
  await steady();
  at = await app.drag(`${row(ids[0])} .tile`, Math.round(w * 0.5), { hold: true, ready: at_(ids[0], Math.round(w * 0.5)) });
  assert.equal((await look(ids[0])).under, 'armed');
  await app.release(at);
  await settled(2);
  assert.match(await app.evaluate("document.querySelector('.toast')?.innerText ?? ''"), /Cleared 1 result/);
  await app.click('.toast .linkbtn');
  await settled(3);
  // To the left works the same; the red side is on the right then.
  await steady();
  at = await app.drag(`${row(ids[1])} .tile`, -Math.round(w * 0.5), { hold: true, ready: at_(ids[1], -Math.round(w * 0.5)) });
  assert.deepEqual(await look(ids[1]), { x: -Math.round(w * 0.5), under: 'armed', side: 'right' });
  await app.release(at);
  await settled(2);
  assert.deepEqual(await app.evaluate("return [...document.querySelectorAll('#chat-ins .res')].map((x) => x.dataset.nav);"), [ids[0], ids[2]]);
  // (A quick flick clears before a third of the width too; the hidden test window hands moves over too slowly for a
  // speed, so test/swipe.test.ts covers it.)
  // A drag more down than sideways is a scroll: the row never moves.
  await steady();
  at = await app.drag(`${row(ids[0])} .tile`, 10, { dy: 40, hold: true });
  assert.deepEqual(await look(ids[0]), { x: 0, under: 'none', side: 'left' });
  await app.release(at);
  // A decision cannot be cleared: it gives a little, with no red side, comes back, and the drag does not select it.
  await steady();
  at = await app.drag('#chat-ins .dec[data-dec] .src', 200, { hold: true, ready: "new DOMMatrix(getComputedStyle(document.querySelector('#chat-ins .dec[data-dec]')).transform).m41 > 10" });
  const dx = await app.evaluate("new DOMMatrix(getComputedStyle(document.querySelector('#chat-ins .dec[data-dec]')).transform).m41");
  assert.ok(dx > 0 && dx <= 14, String(dx));
  assert.equal(await app.evaluate("document.querySelectorAll('#chat-ins .swipe-under').length"), 0);
  await app.release(at);
  await app.until("!document.querySelector('#chat-ins .swiping') && getComputedStyle(document.querySelector('#chat-ins .dec[data-dec]')).transform === 'none'", 'the decision back in place');
  assert.equal(await app.evaluate("document.querySelectorAll('#chat-ins .dec.sel, #chat-ins .dec[aria-current=\"true\"]').length"), 0);
  assert.equal(await app.evaluate("document.querySelectorAll('#chat-ins .res').length"), 2);
});

flow('a two-finger touchpad swipe over a Notifications row clears it like the drag; a short one or a scroll leaves it', {}, async (app) => {
  await app.say('@fake task - First one\n@@fake result One.\n@fake task - Second one\n@@fake result Two.');
  await app.until("document.querySelectorAll('#chat-ins .res').length === 2", 'two results');
  const ids = await app.evaluate("return [...document.querySelectorAll('#chat-ins .res')].map((x) => x.dataset.nav);");
  const w = await app.evaluate("document.querySelector('#chat-ins .res').offsetWidth");
  const row = (nav) => `#chat-ins .res[data-nav="${nav}"]`;
  // The wheel events a touchpad sends, handed to the row in the page: a window off screen gets real input late.
  const wheel = (nav, dx, dy = 0, n = 6) => app.evaluate(`const el = document.querySelector('${row(nav)} .tile'); let kept = 0; for (let i = 0; i < ${n}; i++) { if (!el.dispatchEvent(new WheelEvent('wheel', { deltaX: ${dx / n}, deltaY: ${dy / n}, bubbles: true, cancelable: true }))) kept++; } return kept;`);
  const x = (nav) => app.evaluate(`const r = document.querySelector('${row(nav)}'); return r ? Math.round(new DOMMatrix(getComputedStyle(r).transform).m41) : null;`);
  const rest = (n) => app.until(`document.querySelectorAll('#chat-ins .res').length === ${n} && !document.querySelector('#chat-ins .swiping, #chat-ins .swipe-under')`, `${n} results at rest`);
  // Fingers lifted between two gestures: wheel events right after one (its momentum) start nothing.
  const lift = () => app.evaluate('await new Promise((r) => setTimeout(r, 300)); return 1;');
  // A short swipe: the row follows the fingers (content scrolled right moves the row left), then comes back.
  assert.equal(await wheel(ids[0], Math.round(w * 0.2)), 6);
  assert.equal(await x(ids[0]), -Math.round(w * 0.2));
  await rest(2);
  assert.equal(await x(ids[0]), 0);
  // A scroll down over the row is the list's: nothing is held back and the row stays.
  await lift();
  assert.equal(await wheel(ids[0], 2, 60), 0);
  assert.equal(await x(ids[0]), 0);
  await rest(2);
  // Past 35% to the right: armed, and once the gesture stops the row is cleared with the toast and Undo.
  await lift();
  await wheel(ids[1], -Math.round(w * 0.5));
  assert.ok(await app.evaluate("document.querySelector('#chat-ins .swipe-under')?.classList.contains('armed')"));
  await rest(1);
  assert.match(await app.evaluate("document.querySelector('.toast')?.innerText ?? ''"), /Cleared 1 result/);
  await app.click('.toast .linkbtn');
  await rest(2);
});
