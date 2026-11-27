// End-to-end flows: Names, focus and the keyboard: every control has a name, tooltips, layers, Tab stops and arrow keys.
// Each flow starts the built app on its own empty profile with fake agents and a stand-in for gh. Run with `npm run e2e`.
import assert from 'node:assert/strict';
import { flow } from './harness.mjs';

// Every control on a screen has a name a screen reader can say. Returns what does not, as short HTML.
const NAMELESS = `return (() => {
  const shown = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const named = (el) => {
    const id = el.id;
    const labelled = !!el.closest('label') || (!!id && !!document.querySelector('label[for="' + id + '"]')) || !!el.getAttribute('aria-labelledby');
    return !!((el.getAttribute('aria-label') || '').trim() || (el.textContent || '').trim() || labelled || (el.placeholder || '').trim());
  };
  return [...document.querySelectorAll('button, a[data-action], [role="button"], [role="link"], [role="tab"], input:not([type="hidden"]), textarea, select')]
    .filter((el) => shown(el) && !named(el)).map((el) => el.outerHTML.slice(0, 160));
})();`;

flow('every control on the main screens has a name, and the keyboard keeps its place when a screen is drawn again', { repos: ['demo'], gh: { issues: [{ number: 3, title: 'An issue', url: 'https://github.com/o/demo/issues/3', labels: [], updatedAt: '2026-11-20T00:00:00Z' }] } }, async (app) => {
  await app.say('@fake task - Ask something\n@@fake permission npm install x\n@@fake result Done.\n@fake task demo A change\n@@fake pr https://github.com/o/demo/pull/1\n@@fake result Changed.');
  await app.until("return !!document.querySelector('#chat-ins .dec') && (await window.ide.call('state')).tasks.some((x) => x.status === 'pr_open');", 'a decision and a PR');
  await app.evaluate("await window.ide.call('pr:check'); return 1;");
  await app.until("!!document.querySelector('#chat-ins .prmerge')", 'the Merge button');
  const nameless = {};
  // No hint is left to the OS: every one is the app's own tooltip (data-tip).
  const titled = {};
  const look = async (screen) => {
    const list = await app.evaluate(NAMELESS);
    if (list.length) nameless[screen] = list;
    const native = await app.evaluate("[...document.querySelectorAll('[title]')].map((el) => el.outerHTML.slice(0, 120))");
    if (native.length) titled[screen] = native;
  };
  await look('chat');
  for (const tab of ['memo', 'auto']) { await app.click(`[data-action="ins-tab"][data-v="${tab}"]`); await look(`chat inspector: ${tab}`); }
  await app.click('[data-action="ins-tab"][data-v="inbox"]');
  await app.click('button[data-v="worker"]');
  await look('worker list');
  await app.click('#wk-list [data-action="select-worker"]');
  await app.click('#wk-list [data-action="select-worker"]');
  await look('worker');
  await app.click('button[data-v="repo"]');
  await app.click('#repo-main [data-action="repo-select"]');
  await app.until("!!document.querySelector('[data-action=\"issue-assign\"]')", 'the issues');
  await look('repositories');
  await app.click('button[data-v="memory"]');
  await look('memory');
  await app.click('[data-action="open-settings"]');
  for (const pane of ['accounts', 'general', 'display', 'alerts', 'memory', 'models']) { await app.click(`[data-action="pane"][data-id="${pane}"]`); await look(`settings: ${pane}`); }
  await app.click('[data-action="close-settings"]');
  await app.click('#cmdk-btn');
  await look('palette');
  await app.evaluate("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 1;");
  assert.deepEqual(nameless, {});
  assert.deepEqual(titled, {});

  // Focus on a button in the inbox, then the whole window is drawn again: the focus is on the same button.
  await app.click('button[data-v="chat"]');
  await app.evaluate("document.querySelector('#chat-ins [data-action=\"answer\"][data-val=\"deny\"]').focus(); return 1;");
  await app.evaluate("await window.ide.call('pr:check'); window.dispatchEvent(new Event('focus')); return 1;");
  await app.say('@fake say Something new, so the screen is drawn again.');
  await app.until("document.querySelector('#chat-thread').innerText.includes('Something new')", 'the new message');
  assert.equal(await app.evaluate("document.activeElement?.dataset?.action + ':' + document.activeElement?.dataset?.id?.length"), 'answer:' + (await app.evaluate("document.querySelector('#chat-ins [data-action=\"answer\"]').dataset.id.length")));
});

flow('the tooltip shows a control\'s name and shortcut on hover and on keyboard focus, and cut text in full', {}, async (app) => {
  await app.evaluate("window.__tip = () => { const el = document.querySelector('#tip'); if (el.hidden || !el.classList.contains('on')) return null; const r = el.getBoundingClientRect(); return { text: el.querySelector('span').textContent, key: el.querySelector('kbd')?.textContent ?? '', top: r.top, bottom: r.bottom, left: r.left, right: r.right }; }; return 1;");
  // What takes a tooltip away (or stops one about to show), kept for the message of a wait that fails.
  await app.evaluate("window.__tipEv = []; const at = () => Math.round(performance.now()); addEventListener('resize', () => __tipEv.push('resize ' + at())); addEventListener('blur', () => __tipEv.push('blur ' + at())); for (const t of ['keydown', 'pointerdown', 'scroll', 'mouseover']) addEventListener(t, (e) => __tipEv.push(t + ' ' + (e.target?.id || e.target?.tagName || '') + ' ' + at()), true); return 1;");
  const TIP = "'tip ' + JSON.stringify({ hidden: document.querySelector('#tip').hidden, on: document.querySelector('#tip').classList.contains('on'), text: document.querySelector('#tip').textContent }) + ' at ' + Math.round(performance.now()) + ' | events ' + __tipEv.slice(-12).join(', ')";
  const tipOn = (what) => app.until('!!window.__tip()', what, 20_000, TIP);
  const tip = () => app.evaluate('return window.__tip();');
  const box = (sel) => app.evaluate(`const r = document.querySelector('${sel}').getBoundingClientRect(); return { top: r.top, bottom: r.bottom };`);
  const mod = process.platform === 'darwin' ? '⌘' : 'Ctrl+';
  // A corner of the window with no control and no text under it: the middle of the thread can hold a cut title.
  const AWAY = { x: 3, y: 3 };
  assert.ok(!(await tip()));
  // Hover: after the delay, above the control.
  await app.hover('.side-foot [data-action="open-settings"]');
  await tipOn('the tooltip on hover');
  const above = await tip();
  assert.equal(above.text, 'Settings');
  assert.ok(above.bottom < (await box('.side-foot [data-action="open-settings"]')).top, 'above the control');
  await app.hover(AWAY);
  await app.until('!window.__tip()', 'the tooltip gone when the pointer leaves the control', 20_000, TIP);
  // The shortcut is a key, not part of the sentence; in the top strip the tooltip sits below.
  await app.hover('#side-toggle');
  await tipOn('the tooltip on a control with a shortcut');
  const shown = await tip();
  assert.equal(shown.text, 'Collapse the sidebar');
  assert.equal(shown.key, `${mod}B`);
  assert.ok(shown.top > (await box('#side-toggle')).bottom, 'below a control in the top strip');
  // The name is already the button's label: the tooltip does not describe it again.
  assert.equal(await app.evaluate("return document.querySelector('#side-toggle').getAttribute('aria-describedby') ?? '';"), '');
  assert.equal(await app.evaluate("return document.querySelector('#side-toggle').getAttribute('aria-keyshortcuts');"), process.platform === 'darwin' ? 'Meta+B' : 'Control+B');
  // A key takes it away.
  await app.key('Escape', 'Escape', 27);
  await app.until('!window.__tip()', 'the tooltip gone after a key', 20_000, TIP);
  // Keyboard focus shows it at once; in the toolbar it sits below.
  await app.hover(AWAY);
  await app.evaluate("document.querySelector('#cmdk-btn').focus({ focusVisible: true }); return 1;");
  await app.until("window.__tip()?.text === 'Search and go'", 'the tooltip on focus', 20_000, TIP);
  const below = await tip();
  assert.equal(below.key, `${mod}K`);
  assert.ok(below.top > (await box('#cmdk-btn')).bottom, 'below a toolbar control');
  await app.evaluate("document.querySelector('#chat-input').focus(); return 1;");
  await app.until('!window.__tip()', 'the tooltip gone on blur', 20_000, TIP);
  // Cut text: a long title in the sidebar shows in full; a short one has nothing to add.
  const long = 'A task with a title that is far too long to fit in one line of the sidebar row';
  await app.say(`@fake task - ${long}\n@@fake result Done.\n@fake task - Short\n@@fake result Done.`);
  await app.until("!!document.querySelector('#side [data-action=\"done-toggle\"]') && document.querySelectorAll('#chat-ins .res').length >= 2", 'both tasks done');
  await app.click('#side [data-action="done-toggle"]');
  await app.until("[...document.querySelectorAll('#side .row .t b')].filter((x) => x.textContent.includes('far too long') || x.textContent.trim() === 'Short').length >= 2", 'two rows in the sidebar');
  await app.evaluate("const all = [...document.querySelectorAll('#side .row .t b')]; all.find((x) => x.textContent.includes('far too long')).id = 'e2e-long'; all.find((x) => x.textContent.trim() === 'Short').id = 'e2e-short'; return 1;");
  await app.hover('#e2e-long');
  await tipOn('the tooltip on cut text');
  const cut = await tip();
  assert.match(cut.text, /far too long to fit in one line of the sidebar row/);
  assert.ok(cut.left >= 8 && cut.right <= (await app.evaluate('window.innerWidth')) - 8, 'inside the window');
  await app.hover(AWAY);
  await app.until('!window.__tip()', 'the tooltip gone when the pointer leaves', 20_000, TIP);
  // hover() returns once the page has handed the row its mouseover; the hover delay (500 ms) is then let pass in the
  // page's own time, so a late page cannot make the check come early.
  await app.hover('#e2e-short');
  await app.until("performance.now() - __e2e.overAt >= 800", 'the hover delay passed on the short title', 20_000, TIP);
  assert.ok(!(await tip()), 'no tooltip for text that fits');
});

flow('a layer takes the focus and gives it back, and tabs and choices answer the arrow keys', {}, async (app) => {
  const mod = process.platform === 'darwin' ? 4 : 2;
  const esc = () => app.key('Escape', 'Escape', 27);
  const inSettings = "!!document.querySelector('#sheet .snav-i.on') && document.activeElement === document.querySelector('#sheet .snav-i.on')";
  await app.evaluate("document.querySelector('#chat-input').focus()");
  // Settings takes the focus, so what is typed no longer goes to the chat behind it; closing gives it back.
  await app.key('Comma', ',', 188, mod);
  await app.until(inSettings, 'the focus in Settings');
  await esc();
  await app.until("document.activeElement?.id === 'chat-input'", 'the focus back from Settings');
  await app.key('KeyK', 'k', 75, mod);
  await app.until("document.activeElement?.id === 'cmdk-q'", 'the focus in the palette');
  await esc();
  await app.until("document.activeElement?.id === 'chat-input'", 'the focus back from the palette');
  await app.key('Slash', '/', 191, mod);
  await app.until("document.activeElement?.dataset.action === 'keys-close'", 'the focus in the list of keys');
  await esc();
  await app.until("document.activeElement?.id === 'chat-input'", 'the focus back from the list of keys');

  // The inbox tabs are one Tab stop: the arrows, Home and End move and choose, and the pane is named by its tab.
  const stops = "[...document.querySelectorAll('#chat-ins [role=\"tab\"]')].map((b) => b.tabIndex).join()";
  assert.match(await app.evaluate(stops), /^0(,-1)+$/);
  await app.evaluate("document.querySelector('#ins-tab-inbox').focus()");
  await app.key('ArrowRight', 'ArrowRight', 39);
  await app.until("document.activeElement?.id === 'ins-tab-memo' && document.activeElement.getAttribute('aria-selected') === 'true'", 'the next tab');
  assert.match(await app.evaluate(stops), /^-1,0(,-1)+$/);
  assert.equal(await app.evaluate("const p = document.querySelector('#ins-panel'); return p.getAttribute('role') + ' ' + p.getAttribute('aria-labelledby');"), 'tabpanel ins-tab-memo');
  await app.key('ArrowLeft', 'ArrowLeft', 37);
  await app.until("document.activeElement?.id === 'ins-tab-inbox'", 'the tab before');
  await app.key('ArrowLeft', 'ArrowLeft', 37);
  await app.until("document.activeElement === [...document.querySelectorAll('#chat-ins [role=\"tab\"]')].pop()", 'round the start to the last tab');
  await app.key('Home', 'Home', 36);
  await app.until("document.activeElement?.id === 'ins-tab-inbox'", 'the first tab');

  // Opened from a tab, Settings gives the focus back to that tab. Its choices move with the arrows too, and a
  // choice that has just been made keeps the focus while the sheet saves.
  await app.key('Comma', ',', 188, mod);
  await app.until(inSettings, 'the focus in Settings again');
  const was = await app.evaluate("const b = [...document.querySelectorAll('#sheet button[role=\"radio\"][aria-checked=\"true\"]')].find((x) => x.getClientRects().length); b.focus(); return { group: b.dataset.segc, v: b.dataset.v, stops: [...b.parentElement.querySelectorAll('button[role=\"radio\"]')].filter((x) => x.tabIndex === 0).length };");
  assert.equal(was.stops, 1, 'one Tab stop in the group');
  await app.key('ArrowRight', 'ArrowRight', 39);
  const now = await app.until(`const a = document.activeElement; return a?.dataset.segc === ${JSON.stringify(was.group)} && a.dataset.v !== ${JSON.stringify(was.v)} && a.getAttribute('aria-checked') === 'true' && a.tabIndex === 0 && { v: a.dataset.v, field: document.getElementById(a.dataset.segc).value };`, 'the next choice');
  assert.equal(now.field, now.v);
  await app.key('ArrowLeft', 'ArrowLeft', 37);
  await app.until(`document.activeElement?.dataset.segc === ${JSON.stringify(was.group)} && document.activeElement.dataset.v === ${JSON.stringify(was.v)}`, 'the choice before');
  await esc();
  await app.until("document.activeElement?.id === 'ins-tab-inbox'", 'the focus back on the tab');
});

flow('a conversation is one Tab stop, and the arrows move between its messages', {}, async (app) => {
  const tab = (shift = false) => app.key('Tab', 'Tab', 9, shift ? 8 : 0);
  const up = () => app.key('ArrowUp', 'ArrowUp', 38);
  // What has the focus: the composer, a message by its place in the thread, or a control in a message.
  const AT = `const a = document.activeElement; const th = document.querySelector('#chat-thread');
    if (a?.id === 'chat-input') return 'composer';
    if (!th.contains(a)) return 'out';
    const rows = [...th.children].filter((x) => !x.matches('.stamp, .who, .new-from'));
    const i = rows.findIndex((r) => r.contains(a));
    return (a === rows[i] ? 'message ' : 'control ') + (i - rows.length);`;
  // An empty conversation has no message to stop on: Tab goes on to what it offers.
  // The toolbar's last stop is the informational pill (K1), after the right sidebar's button.
  await app.evaluate("document.querySelector('#ins-toggle').focus()");
  await tab();
  assert.equal(await app.evaluate("document.activeElement?.id"), 'fake-badge');
  await tab();
  assert.equal(await app.evaluate("document.activeElement?.dataset.action"), 'chat-start');
  for (let i = 1; i <= 6; i++) {
    await app.say(`Question ${i}\n@fake say Answer ${i} with https://example.com/${i}.`);
    await app.until(`document.querySelector('#chat-thread').innerText.includes('Answer ${i} with')`, `answer ${i}`);
  }
  // From the toolbar, the thread is one stop (its last message), however many links and reply buttons it holds.
  await app.evaluate("document.querySelector('#fake-badge').focus()");
  await tab();
  await app.until("document.querySelector('#chat-thread').contains(document.activeElement)", 'the focus in the thread');
  assert.equal(await app.evaluate(AT), 'message -1');
  // Tab inside a message reaches its own controls, then leaves the thread for the composer.
  const seen = [];
  for (let i = 0; i < 6 && seen[seen.length - 1] !== 'composer'; i++) { await tab(); seen.push(await app.evaluate(AT)); }
  assert.equal(seen[seen.length - 1], 'composer');
  assert.ok(seen.length >= 2 && seen.slice(0, -1).every((x) => x === 'control -1'), `only the last message's controls on the way: ${seen}`);
  // Back from the composer the thread is where it was left; the arrows move between messages and stop at the ends.
  await tab(true);
  assert.equal(await app.evaluate(AT), 'message -1');
  await up(); await up();
  assert.equal(await app.evaluate(AT), 'message -3');
  await app.key('Home', 'Home', 36);
  const first = await app.evaluate(AT);
  await up();
  assert.equal(await app.evaluate(AT), first, 'the first message is the end');
  await app.key('End', 'End', 35);
  assert.equal(await app.evaluate(AT), 'message -1');
  await up();
  // A new message draws the thread again: the focus stays on the message it was on.
  await app.say('Question 7\n@fake say Answer 7.');
  await app.until("document.querySelector('#chat-thread').innerText.includes('Answer 7.')", 'answer 7');
  assert.equal(await app.evaluate(AT), 'message -4');
  assert.equal(await app.evaluate("getComputedStyle(document.activeElement).outlineStyle"), 'solid');
});

flow('the app starts in the message field, the views are one Tab stop, and a narrow window keeps the chat wide', {}, async (app) => {
  const mod = process.platform === 'darwin' ? 4 : 2;
  // K1: the focus starts in the message field, and Ctrl/Cmd+L brings it back there from another view.
  await app.until("document.activeElement?.id === 'chat-input'", 'the focus in the message field at start');
  const stops = "[...document.querySelectorAll('#views [role=\"tab\"]')].map((b) => b.tabIndex + (b.getAttribute('aria-selected') === 'true' ? '*' : '')).join()";
  assert.equal(await app.evaluate(stops), '0*,-1,-1,-1');
  await app.evaluate("document.querySelector('#views [aria-selected=\"true\"]').focus(); return 1;");
  await app.key('ArrowRight', 'ArrowRight', 39);
  await app.until("document.activeElement?.dataset.v === 'worker' && !document.querySelector('[data-view=\"worker\"].content').hidden", 'the next view, chosen and focused');
  assert.equal(await app.evaluate(stops), '-1,0*,-1,-1');
  await app.key('End', 'End', 35);
  await app.until("document.activeElement?.dataset.v === 'memory' && document.activeElement.getAttribute('aria-selected') === 'true'", 'the last view');
  await app.key('ArrowRight', 'ArrowRight', 39);
  await app.until("document.activeElement?.dataset.v === 'chat'", 'round the end to the first view');
  await app.key('ArrowLeft', 'ArrowLeft', 37);
  await app.until("document.activeElement?.dataset.v === 'memory'", 'round the start to the last view');
  await app.key('KeyL', 'l', 76, mod);
  await app.until("document.activeElement?.id === 'chat-input' && !document.querySelector('[data-view=\"chat\"].content').hidden", 'the message field from Ctrl+L');
  // The list of keys names it.
  await app.key('Slash', '/', 191, mod);
  await app.until("document.querySelector('#dlg .keys')?.innerText.includes('Message field')", 'Ctrl+L in the list of keys');
  await app.key('Escape', 'Escape', 27);

  // I1: below 1100 the right sidebar is a drawer, closed, and its button names it; the chat keeps its width.
  const box = "const r = (q) => document.querySelector(q).getBoundingClientRect(); const w = document.querySelector('#win').classList; return JSON.stringify({ main: r('main[data-view=\"chat\"]').width, ins: r('#chat-ins').left, over: w.contains('ins-over'), insMin: w.contains('ins-min'), sideMin: w.contains('side-min'), lbl: getComputedStyle(document.querySelector('#ins-lbl')).display });";
  await app.size(1000, 760);
  let b = JSON.parse(await app.until(`return document.querySelector('#win').classList.contains('ins-over') && (() => { ${box} })()`, 'the drawer at 1000px'));
  assert.ok(b.insMin && !b.sideMin && b.lbl !== 'none' && b.main >= 520, JSON.stringify(b));
  const mainW = b.main;
  await app.click('#ins-toggle');
  b = JSON.parse(await app.until(`return !document.querySelector('#win').classList.contains('ins-min') && (() => { ${box} })()`, 'the drawer open'));
  assert.equal(b.main, mainW, 'the open drawer covers the chat instead of narrowing it');
  assert.ok(b.ins < 1000 && b.ins > 1000 - 400, JSON.stringify(b));
  // Escape closes it; so does a press on the chat.
  await app.evaluate("document.querySelector('#chat-ins [role=\"tab\"][aria-selected=\"true\"]').focus(); return 1;");
  await app.key('Escape', 'Escape', 27);
  await app.until("document.querySelector('#win').classList.contains('ins-min') && document.activeElement?.id === 'ins-toggle'", 'closed by Escape, the focus on its button');
  await app.click('#ins-toggle');
  await app.until("!document.querySelector('#win').classList.contains('ins-min')", 'open again');
  for (const type of ['mousePressed', 'mouseReleased']) await app.cdp('Input.dispatchMouseEvent', { type, x: 400, y: 300, button: 'left', clickCount: 1 });
  await app.until("document.querySelector('#win').classList.contains('ins-min')", 'closed by a press on the chat');
  // Below 960 the left sidebar is a rail too.
  await app.size(900, 760);
  b = JSON.parse(await app.until(`return document.querySelector('#win').classList.contains('side-min') && (() => { ${box} })()`, 'the rail at 900px'));
  assert.ok(b.main >= 520, JSON.stringify(b));
  // The rail is 60 wide on every system (it starts below the top strip: strip.e2e.mjs), and the strip's controls end
  // clear of the caption buttons (150px at 100%). The grid animates, so wait for it to settle.
  await app.until("return Math.abs(document.querySelector('.sidebar').getBoundingClientRect().right - 60) < 0.5", 'the rail 60px wide');
  for (const w of [900, 760]) {
    await app.size(w, 760);
    const end = Number(await app.until(`return (() => { if (document.querySelector('.platform-darwin')) return 1; const r = Math.max(...[...document.querySelector('.toolbar').children].filter((e) => e.offsetParent).map((e) => e.getBoundingClientRect().right)); return r <= innerWidth - 150 + 0.5 ? String(r) : ''; })()`, `the toolbar clear of the caption buttons at ${w}px`));
    assert.ok(end > 0, String(end));
  }
  // Wide again, both come back as they were.
  await app.size(1320, 860);
  b = JSON.parse(await app.until(`return !document.querySelector('#win').classList.contains('ins-over') && (() => { ${box} })()`, 'wide again'));
  assert.ok(!b.insMin && !b.sideMin && b.lbl === 'none', JSON.stringify(b));
});
