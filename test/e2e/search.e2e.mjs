// End-to-end flows: The palette and the quick message box: finding a task or something said, and sending from anywhere.
// Each flow starts the built app on its own empty profile with fake agents and a stand-in for gh. Run with `npm run e2e`.
import assert from 'node:assert/strict';
import { flow } from './harness.mjs';

flow('the palette finds a finished task, and coming back shows what happened', {}, async (app) => {
  await app.say('@fake task - Tidy the changelog\n@@fake result Tidied the changelog.');
  await app.until("!!document.querySelector('#chat-ins .res')", 'the result card');
  await app.click('#cmdk-btn');
  await app.evaluate("const q = document.querySelector('#cmdk-q'); q.value = 'changelog'; q.dispatchEvent(new Event('input', { bubbles: true })); return 1;");
  // The Worker carries the task's title too; the task's own row starts with its id.
  const rows = await app.evaluate("[...document.querySelectorAll('.cmdk-it')].map((el) => el.innerText)");
  const at = rows.findIndex((text) => /^T-0001 Tidy the changelog/.test(text));
  assert.notEqual(at, -1, `no task row in: ${rows.join(' | ')}`);
  await app.click(`#cmdk-${at}`);
  await app.until("document.querySelector('[data-action=\"ws-tab\"][aria-selected=\"true\"]')?.dataset.v === 'summary'", "the Worker's Summary tab");
  // Away for an hour, then back.
  await app.evaluate("localStorage.setItem('oma.lastSeen', new Date(Date.now() - 3600e3).toISOString()); document.querySelector('button[data-v=\"chat\"]').click(); window.dispatchEvent(new Event('focus')); return 1;");
  await app.until("!!document.querySelector('#sec-away')", '"While you were away"');
  assert.match(await app.evaluate("document.querySelector('#sec-away').innerText"), /1 finished[\s\S]*Tidy the changelog/);
  // Other updates draw the inbox again: the card does not play its entrance again, and its focused row keeps the keyboard.
  await app.evaluate("document.querySelector('#sec-away .away-row').focus(); return 1;");
  const still = "[document.querySelector('#sec-away').classList.contains('arrive'), document.getAnimations().filter((a) => a.effect?.target?.closest?.('#sec-away')).length]";
  // Checked the moment the card is drawn anew, while an entrance would still be running.
  assert.deepEqual(await app.evaluate(`document.querySelector('#sec-away').dataset.old = '1'; document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true })); await window.ide.call('preflight:run');
    for (let i = 0; i < 100 && document.querySelector('#sec-away')?.dataset.old; i++) await new Promise((r) => requestAnimationFrame(r));
    return ${still};`), [false, 0]);
  assert.equal(await app.evaluate("document.activeElement?.dataset?.focus?.startsWith('away:') ?? false"), true);
  await app.say('@fake say Something else happened.');
  await app.until("document.querySelector('#chat-thread').innerText.includes('Something else happened')", 'the new message');
  assert.deepEqual(await app.evaluate(still), [false, 0]);
});

flow('the palette finds something said and shows the chat from that message', {}, async (app) => {
  await app.say('Please remember the pineapple rule\n@fake say Noted: no pineapple on Fridays.');
  // The user's own bubble holds the words of the answer too (its @fake line): the wait is for the Dispatcher's message.
  const answered = (words) => `const s = await window.ide.call('state'); return s.chat.some((c) => c.kind === 'dispatcher' && c.text.includes(${JSON.stringify(words)}))`;
  await app.until(answered('no pineapple on Fridays'), "the Dispatcher's answer");
  // Enough later messages that the first is not what the chat opens on.
  for (let i = 0; i < 3; i++) await app.say(`Filler ${i}\n@fake say Filler answer ${i}.`);
  // Every answer in and the turn over, so no message is still being written when the chat jumps to one.
  await app.until(`${answered('Filler answer 2.')} && !s.dispatcher.busy;`, 'the later answers, with the Dispatcher at rest');
  // The blink is for a screen that allows motion (a CI runner may ask for less).
  await app.cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  // Ctrl+F opens the palette to find something said.
  await app.evaluate("document.querySelector('#chat-input').focus(); return 1;");
  await app.key('KeyF', 'f', 70, 2);
  await app.until("document.activeElement?.id === 'cmdk-q'", 'the palette opened by Ctrl+F');
  await app.evaluate("const q = document.querySelector('#cmdk-q'); q.value = 'pineapple fridays'; q.dispatchEvent(new Event('input', { bubbles: true })); return 1;");
  // The row is picked by its words and clicked in the same look, so it cannot be another row drawn in its place.
  await app.until("const el = [...document.querySelectorAll('.cmdk-it')].find((x) => x.innerText.includes('no pineapple on Fridays')); el?.click(); return !!el;", 'the message among the results', 20_000, "[...document.querySelectorAll('.cmdk-it')].map((x) => x.innerText.replace(/\\s+/g, ' ')).join(' / ')");
  // Every match is marked; the one in the message found is current, ringed, pulsing and in the middle of the thread.
  const read = `const th = document.querySelector('#chat-thread'), cur = th.querySelector('mark.find.cur'), r = cur?.getBoundingClientRect(), tr = th.getBoundingClientRect();
    return cur && JSON.stringify({ marks: th.querySelectorAll('mark.find').length, cur: cur.textContent, inBub: cur.closest('.bub')?.innerText ?? '',
      pulse: cur.getAnimations().some((a) => a.animationName === 'hit-pulse'), middle: Math.abs((r.top + r.bottom) / 2 - (tr.top + tr.bottom) / 2) < tr.height / 3 || th.scrollTop === 0,
      count: document.querySelector('.findbar:not(.tm-find) .cnt')?.textContent, ticks: document.querySelectorAll('.find-ticks i').length, on: document.querySelectorAll('.find-ticks i.on').length });`;
  const first = JSON.parse(await app.until(read, 'the matches marked in the chat'));
  assert.match(first.inBub, /no pineapple on Fridays/);
  assert.equal(first.cur.toLowerCase(), 'pineapple');
  assert.equal(first.pulse, true);
  assert.equal(first.middle, true);
  assert.equal(first.count, `1/${first.marks}`);
  assert.deepEqual([first.ticks, first.on], [first.marks, 1]);
  // The thread now starts at that message: what was said before it is above, not shown.
  assert.equal(await app.evaluate("document.querySelector('#chat-thread').innerText.includes('Please remember the pineapple rule')"), false);
  // The bar's buttons are icons with names; Next moves the current match on.
  const names = await app.evaluate("[...document.querySelectorAll('.findbar:not(.tm-find) button')].map((b) => [b.getAttribute('aria-label'), b.dataset.tip, b.innerText.trim()].join('|'))");
  assert.deepEqual(names, ['Previous match|Previous match|', 'Next match|Next match|', 'Close search|Close search|']);
  await app.click('.findbar:not(.tm-find) [data-action="find-next"]');
  const next = JSON.parse(await app.until(read, 'the next match'));
  assert.deepEqual([next.count, next.cur], [`2/${first.marks}`, 'Fridays']);
  // A new message draws the thread again, and may show what was said before: the current match stays the same word.
  await app.say('@fake say Another word.');
  await app.until("document.querySelector('#chat-thread').innerText.includes('Another word.')", 'the new message');
  const after = JSON.parse(await app.until(read, 'the marks after a redraw'));
  assert.equal(after.cur, 'Fridays');
  assert.match(after.inBub, /^Noted: no pineapple on Fridays/);
  // Escape closes the search and takes the marks off.
  await app.evaluate("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 1;");
  await app.until("!document.querySelector('#chat-thread mark.find') && !document.querySelector('.findbar:not(.tm-find)') && !document.querySelector('.find-ticks')", 'the search closed');
});

flow('the quick message box completes a repository name, sends to the Dispatcher and remembers the line', { repos: ['billing', 'docs'] }, async (app) => {
  const box = await app.openQuick();
  const type = (v) => box.evaluate(`const q = document.getElementById('q'); q.focus(); q.value = ${JSON.stringify(v)}; q.setSelectionRange(q.value.length, q.value.length); q.dispatchEvent(new Event('input', { bubbles: true })); return 1;`);
  const key = (k) => box.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true })); return document.getElementById('q').value;`);
  await type('update the guide in @do');
  assert.equal(await box.evaluate("document.getElementById('hint').hidden ? '' : document.getElementById('hint').textContent"), '@docs');
  assert.equal(await key('Tab'), 'update the guide in @docs ');
  await type('update the guide in @docs\n@fake say Guide noted.'.split('\n')[0]);
  await box.evaluate("document.getElementById('f').requestSubmit(); return 1;");
  await box.until("document.getElementById('f').classList.contains('sent')", 'the box saying it was sent');
  // The line is in the chat, as if typed there.
  await app.until("document.querySelector('#chat-thread').innerText.includes('update the guide in @docs')", 'the line in the chat');
  // Opened again: empty, and Up brings the line back.
  const again = await app.openQuick();
  await again.evaluate("window.dispatchEvent(new Event('focus')); return 1;");
  assert.equal(await again.evaluate("document.getElementById('q').value"), '');
  assert.equal(await again.evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })); return document.getElementById('q').value;"), 'update the guide in @docs');
});
