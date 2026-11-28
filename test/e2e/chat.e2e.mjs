// End-to-end flows: The chat with the Dispatcher: its status line, reply branches, a new conversation and the first run.
// Each flow starts the built app on its own empty profile with fake agents and a stand-in for gh. Run with `npm run e2e`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { flow } from './harness.mjs';

flow('while the Dispatcher works, the composer has a status line with Stop and the Chat tab a dot', {}, async (app) => {
  await app.say('@fake wait 4000\n@fake say Done waiting.');
  await app.until("!document.querySelector('#chat-dstat').hidden", 'the status line');
  assert.match(await app.evaluate("document.querySelector('#chat-dstat').innerText"), /Dispatcher/);
  assert.equal(await app.evaluate("!!document.querySelector('#chat-dstat [data-action=\"chat-stop\"]')"), true);
  assert.equal(await app.evaluate("!!document.querySelector('#views button[data-v=\"chat\"].busy')"), true);
  await app.click('#chat-dstat [data-action="chat-stop"]');
  await app.until("document.querySelector('#chat-dstat').hidden && !document.querySelector('#views button[data-v=\"chat\"].busy')", 'the status line gone after Stop');
});

flow('replies hang one step in under what they answer on opaque branches that light up and go back to it', {}, async (app) => {
  const send = (text) => app.evaluate(`const i = document.querySelector('#chat-input'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#chat-form').requestSubmit(); return 1;`);
  // The Worker reports after the Dispatcher's turn has ended, so nothing comes between the card and the reply.
  await app.say('@fake task - Write the notes\n@@fake wait 800\n@@fake result Wrote the notes.');
  const card = '#chat-thread > .attach[data-task]';
  const link = `${card} [data-action="reply"]`;
  const br = `${card} + .br`;
  await app.until(`!!document.querySelector(${JSON.stringify(link)})`, 'Reply on the result card');
  await app.click(link);
  await send('Why so short?\n@fake say The notes cover one change.');
  await app.until(`document.querySelector(${JSON.stringify(br)})?.innerText.includes('The notes cover one change.')`, 'the branch under the card');
  // Both messages stay in the chat, one step in, on the branch's end: the user's bubble where the Dispatcher's is,
  // without the quote of the card the line already shows.
  const near = await app.evaluate(`const c = document.querySelector(${JSON.stringify(card)}), b = c.nextElementSibling, rows = [...b.querySelectorAll(':scope > .br-r')];
    const left = (r) => Math.round(r.querySelector('.bub').getBoundingClientRect().left);
    return { late: b.classList.contains('late'), sides: rows.map((r) => r.classList[1]), step: left(rows[0]) - Math.round(c.getBoundingClientRect().left), same: left(rows[0]) === left(rows[1]),
      quote: !!rows[0].querySelector('.bq'), text: rows[0].innerText.trim().split(String.fromCharCode(10))[0], gap: Math.round(rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().bottom) };`);
  assert.deepEqual(near, { late: false, sides: ['me', 'ai'], step: 48, same: true, quote: false, text: 'Why so short?', gap: 6 });
  // The line: one opaque colour; each row's trunk piece ends where its elbow starts, so no two pieces overlap.
  const lines = await app.evaluate(`const r = document.querySelector(${JSON.stringify(`${br} > .br-r`)}), b = getComputedStyle(r, '::before'), a = getComputedStyle(r, '::after'), el = getComputedStyle(r.querySelector('.el'));
    return { colors: new Set([b.borderLeftColor, a.borderLeftColor, el.borderLeftColor, el.borderBottomColor]).size, color: el.borderLeftColor,
      meet: parseFloat(b.top) + parseFloat(b.height) === parseFloat(a.top) && parseFloat(a.top) === parseFloat(el.top) };`);
  assert.equal(lines.colors, 1);
  assert.match(lines.color, /^rgb\(/, 'opaque');
  assert.equal(lines.meet, true);
  // Under the pointer the way back turns blue and the card gets its ring; away, it goes back.
  const lastEl = `document.querySelector(${JSON.stringify(`${br} > .br-r:last-child > .el`)})`;
  await app.evaluate(`document.querySelector(${JSON.stringify(`${br} > .br-r:last-child .bub`)}).dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); return 1;`);
  const lit = await app.evaluate(`const rows = document.querySelectorAll(${JSON.stringify(`${br} > .br-r`)}); return { cls: [...rows].map((r) => [r.classList.contains('lit'), r.classList.contains('thru')]), ring: document.querySelector(${JSON.stringify(card)}).classList.contains('reply-on'), color: getComputedStyle(${lastEl}).borderLeftColor };`);
  assert.deepEqual(lit.cls, [[false, true], [true, false]]);
  assert.equal(lit.ring, true);
  assert.notEqual(lit.color, lines.color, 'the lit elbow is blue');
  await app.evaluate(`document.querySelector('#chat-thread').dispatchEvent(new MouseEvent('mouseleave')); return 1;`);
  assert.equal(await app.evaluate("document.querySelectorAll('#chat-thread .lit, #chat-thread .thru, #chat-thread .reply-on').length"), 0);
  // A click on the line goes back to the card, which flashes once.
  await app.evaluate(`document.querySelector(${JSON.stringify(`${br} .br-go`)}).click(); return 1;`);
  await app.until(`document.querySelector(${JSON.stringify(card)}).classList.contains('flash')`, 'the card flashed');

  // Another talk, then a reply to the report again: it keeps its place in time, on a branch from a tag naming the report.
  await app.say('Something else\n@fake say Something else answered.');
  const bline = "[...document.querySelectorAll('#chat-thread > .bline')].find((b) => b.innerText.includes('Something else answered.'))";
  await app.until(`!!${bline}`, 'the plain answer');
  await app.click(link);
  await send('Any more?\n@fake say Not now.');
  const lastLate = "[...document.querySelectorAll('#chat-thread > .br.late')].pop()";
  await app.until(`${lastLate}?.innerText.includes('Not now.')`, 'the late branch');
  const late = await app.evaluate(`const b = ${lastLate}; return { tag: b.firstElementChild.matches('.otag') && b.querySelector('.otag .q').textContent, last: !b.nextElementSibling?.matches('.bub, .bline, .attach, .br'), sides: [...b.querySelectorAll('.br-r')].map((r) => r.classList[1]) };`);
  assert.deepEqual(late, { tag: 'Write the notes', last: true, sides: ['me', 'ai'] });
  // The tag is a button: the keyboard reaches it, its focus lights the way, and pressing it goes back to the card.
  await app.evaluate(`document.querySelector(${JSON.stringify(card)}).classList.remove('flash'); ${lastLate}.querySelector('.otag').focus(); return 1;`);
  // The test window is not the focused one, so focus() fires no focus events: send the one a real focus sends.
  await app.evaluate(`document.activeElement.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); return 1;`);
  assert.equal(await app.evaluate(`document.querySelector(${JSON.stringify(card)}).classList.contains('reply-on')`), true, 'focus lights the way too');
  await app.evaluate(`document.activeElement.click(); return 1;`);
  await app.until(`document.querySelector(${JSON.stringify(card)}).classList.contains('flash')`, 'the tag went back');
  const filed = (await app.state()).chat.filter((c) => c.replyTo).map((c) => [c.kind, c.replyTo]);
  assert.deepEqual(filed, [['user', 'T-0001'], ['dispatcher', 'T-0001'], ['user', 'T-0001'], ['dispatcher', 'T-0001']]);

  // R on a Dispatcher message starts a reply to it; the answer goes on a branch from a tag that names the Dispatcher.
  await app.evaluate(`const b = ${bline}; b.tabIndex = -1; b.focus(); return 1;`);
  await app.key('KeyR', 'r', 82);
  await app.until("!document.querySelector('#chat-reply').hidden && document.activeElement?.id === 'chat-input'", 'R opened the reply');
  assert.equal(await app.evaluate("document.querySelector('#chat-reply b').textContent"), 'Dispatcher');
  await send('Thanks\n@fake say Any time.');
  await app.until(`${lastLate}?.innerText.includes('Any time.')`, 'the branch of the Dispatcher message');
  assert.equal(await app.evaluate(`${lastLate}.querySelector('.otag b').textContent`), 'Dispatcher');
  const root = (await app.state()).chat.find((c) => c.text === 'Something else answered.').id;
  assert.deepEqual((await app.state()).chat.filter((c) => c.replyTo === root).map((c) => c.kind), ['user', 'dispatcher']);
  // R on the user's own reply answers what its branch answers.
  await app.evaluate("const r = [...document.querySelectorAll('#chat-thread .br-r.me')].find((x) => x.innerText.includes('Why so short?')); r.tabIndex = -1; r.focus(); return 1;");
  await app.key('KeyR', 'r', 82);
  await app.until("!document.querySelector('#chat-reply').hidden && document.querySelector('#chat-reply span').textContent.includes('Write the notes')", 'R on my reply answers the report');
  await app.click('#chat-reply [data-action="reply-cancel"]');

  // Light and dark: the line is opaque in both, and differs between them.
  const colorIn = async (theme) => {
    await app.evaluate(`document.documentElement.dataset.theme = '${theme}'; return 1;`);
    return app.evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(`${br} > .br-r > .el`)})).borderLeftColor`);
  };
  const dark = await colorIn('dark'), light = await colorIn('light');
  assert.notEqual(dark, light);
  for (const c of [dark, light]) assert.match(c, /^rgb\(/, `${c} is opaque`);
  await app.evaluate("document.documentElement.dataset.theme = 'dark'; return 1;");
});

flow('starting a new conversation asks first, and the context menu opens only with something in it', {}, async (app) => {
  // No context and nothing spent: the meter has no menu to open.
  assert.equal(await app.evaluate("document.querySelector('#chat-ctx').disabled"), true);
  await app.say('Remember the pineapple rule\n@fake tokens 60000\n@fake say Noted.');
  await app.until("!document.querySelector('#chat-ctx').disabled", 'the meter with a context');
  const openMenu = async () => {
    await app.click('#chat-ctx');
    await app.until("!document.querySelector('#ctxmenu').hidden", 'the context menu');
  };
  await openMenu();
  const menu = await app.evaluate("const m = document.querySelector('#ctxmenu'); const r = m.getBoundingClientRect(); const b = document.querySelector('#chat-ctx').getBoundingClientRect(); return { roles: [...m.querySelectorAll('button')].map((x) => x.getAttribute('role')), off: m.querySelectorAll('button:disabled').length, left: r.left, top: r.top, right: r.right, bottom: r.bottom, meterTop: b.top, meterRight: b.right, vw: innerWidth, focus: document.activeElement?.dataset.action ?? '' };");
  assert.deepEqual(menu.roles, ['menuitem', 'menuitem']);
  assert.equal(menu.off, 0);
  assert.equal(menu.focus, 'ctx-compact');
  // Placed from its measured size: above the meter, right edges together, inside the window.
  assert.ok(menu.bottom <= menu.meterTop && menu.top >= 8, 'above the meter');
  assert.ok(Math.abs(menu.right - menu.meterRight) <= 1 && menu.left >= 8 && menu.right <= menu.vw - 8, 'at the meter, inside the window');
  // "Start new conversation" asks, with what is lost and what goes on; Cancel leaves the context as it is.
  await app.click('#ctxmenu [data-action="ctx-clear"]');
  await app.until("!!document.querySelector('#dlg .dlg')", 'the question');
  assert.equal(await app.evaluate("document.querySelector('#ctxmenu').hidden"), true);
  assert.match(await app.evaluate("document.querySelector('#dlg .dlg').innerText"), /forgets this conversation[\s\S]*running tasks go on/);
  assert.equal(await app.evaluate("document.querySelector('#dlg .btn-danger-fill').dataset.action"), 'confirm-ok');
  await app.click('#dlg .dlg-btns [data-action="confirm-dismiss"]');
  await app.until("document.querySelector('#dlg').hidden", 'the question closed');
  assert.equal((await app.state()).dispatcher.contextTokens, 60000);
  // Confirmed, the Dispatcher starts again and the chat on screen stays.
  await openMenu();
  await app.click('#ctxmenu [data-action="ctx-clear"]');
  await app.until("!!document.querySelector('#dlg .dlg')", 'the question again');
  await app.click('#dlg [data-action="confirm-ok"]');
  await app.until("document.querySelector('#chat-thread').innerText.includes('Started a new Dispatcher conversation')", 'the new conversation');
  assert.equal((await app.state()).dispatcher.contextTokens, 0);
  assert.equal(await app.evaluate("document.querySelector('#chat-thread').innerText.includes('Remember the pineapple rule')"), true);
  await app.until("document.querySelector('#chat-ctx').disabled", 'the meter closed again');
});

flow('without an account the empty chat lists the steps to get started, and the composer waits for one', { env: { OMA_E2E_NO_ACCOUNT: '1' } }, async (app) => {
  // The first run opens Settings on Accounts; behind it, the chat has the steps.
  await app.until("!!document.querySelector('[data-action=\"close-settings\"]')", 'Settings at the first run');
  await app.click('[data-action="close-settings"]');
  await app.until("document.querySelectorAll('#chat-thread .setup-step').length === 3", 'the three steps');
  const steps = await app.evaluate("[...document.querySelectorAll('.setup-step')].map((s) => s.className.replace('setup-step', '').trim() + ': ' + s.innerText.replace(/\\s+/g, ' ').trim())");
  // git and gh are fine here; the account is the step to take, with the primary button; the repository comes after.
  assert.deepEqual(steps, ['done: Check git and gh OK', 'cur: 2 Add a Claude account Add an account', ': 3 Add a repository Add repository']);
  assert.equal(await app.evaluate("document.querySelector('.setup-step.cur .btn').classList.contains('btn-primary')"), true);
  assert.deepEqual(await app.evaluate("const i = document.querySelector('#chat-input'); return [i.disabled, i.placeholder];"), [true, 'Add an account to hand work to the Dispatcher']);
  // The account step opens Settings on Accounts.
  await app.click('.setup-step.cur [data-action="open-settings"]');
  await app.until("document.querySelector('.snav-i.on')?.dataset.id === 'accounts'", 'the Accounts pane');
  await app.click('[data-action="close-settings"]');
  // The repository step opens the add form in the Repositories view; each field has its name above it.
  await app.click('[data-action="setup-repo"]');
  await app.until("document.activeElement?.id === 'repo-add-url'", 'the address field');
  assert.deepEqual(await app.evaluate("['repo-add-url', 'repo-add-desc'].map((id) => document.querySelector('label[for=\"' + id + '\"]')?.textContent)"), ['Address', 'Description (optional)']);
});

flow('attached files with long names stay one-line chips that keep their extension', {}, async (app) => {
  // Not images: those are thumbnails (T-0152).
  const names = ['KakaoTalk_20261126_154210123_attachment_button_wrap.pdf', '첨부버튼_두줄_깨짐_재현_화면_2026-11-26_오후_3시42분.pdf', 'Screenshot 2026-11-26 at 15.42.17 (2).pdf'];
  // Real files: a message keeps only attachments that exist.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-att-'));
  const files = names.map((n) => { const f = path.join(dir, n); fs.writeFileSync(f, 'x'); return f; });
  await app.evaluate(`await window.ide.call('chat:send', 'Three screens', ${JSON.stringify(files)}); return 1;`);
  await app.until("document.querySelectorAll('#chat-thread .bub.me .sent-files .fchip').length === 3", 'the three file chips');
  const chips = JSON.parse(await app.evaluate(`return JSON.stringify([...document.querySelectorAll('#chat-thread .bub.me .sent-files .fchip')].map((c) => {
    const fn = c.querySelector('.fn'), lh = parseFloat(getComputedStyle(fn).lineHeight);
    return { h: c.getBoundingClientRect().height, w: c.getBoundingClientRect().width, oneLine: fn.getBoundingClientRect().height < lh * 1.5, text: fn.textContent, tip: c.dataset.tip, icon: !!c.querySelector('svg.sym') };
  }));`));
  const one = chips[0].h;
  chips.forEach((c, i) => {
    assert.equal(c.oneLine, true, `chip ${i} wraps: ${c.text}`);
    assert.equal(c.h, one, `chip ${i} is ${c.h}px high, not ${one}px`);
    assert.ok(c.w <= 240, `chip ${i} is ${c.w}px wide`);
    assert.ok(c.text.endsWith('.pdf'), `chip ${i} lost its extension: ${c.text}`);
    assert.equal(c.tip, files[i]);
    assert.equal(c.icon, true);
  });
  assert.match(chips[0].text, /^KakaoTalk_.*….*\.pdf$/);
});

flow('Up in an empty composer lists the prompts sent from it, narrows as typed and fills the composer', {}, async (app) => {
  const set = (box, v) => app.evaluate(`const i = document.querySelector('#${box}-input'); i.focus(); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('input', { bubbles: true })); return 1;`);
  const send = async (v) => { await set('chat', v); await app.evaluate("document.querySelector('#chat-form').requestSubmit(); return 1;"); };
  await send('Write the release notes');
  await app.until("return (await window.ide.call('history:list', 'chat')).length === 1", 'the first prompt kept');
  await send('Run the tests again');
  await app.until("return (await window.ide.call('history:list', 'chat')).length === 2", 'both prompts kept');
  const rows = () => app.evaluate("return [...document.querySelectorAll('#cpop-chat .cpop-it')].map((r) => (r.classList.contains('on') ? '*' : '') + r.querySelector('span').textContent)");
  await set('chat', '');
  await app.key('ArrowUp', 'ArrowUp', 38);
  await app.until("document.querySelectorAll('#cpop-chat .cpop-it').length === 2", 'the history open');
  assert.deepEqual(await rows(), ['*Run the tests again', 'Write the release notes']);
  assert.equal(await app.evaluate("document.querySelector('#chat-input').getAttribute('aria-activedescendant')"), 'cpop-chat-0');
  // Up goes to the older prompt, Down back; past the newest the list closes and the draft is as it was.
  await app.key('ArrowUp', 'ArrowUp', 38);
  assert.deepEqual(await rows(), ['Run the tests again', '*Write the release notes']);
  await app.key('ArrowDown', 'ArrowDown', 40);
  await app.key('ArrowDown', 'ArrowDown', 40);
  await app.until("!document.querySelector('#cpop-chat')", 'the list closed past the newest');
  assert.equal(await app.evaluate("document.querySelector('#chat-input').value"), '');
  // Typing narrows it and marks the match; Enter fills the composer and sends nothing.
  await app.key('ArrowUp', 'ArrowUp', 38);
  await app.until("!!document.querySelector('#cpop-chat')", 'the history open again');
  await set('chat', 'notes');
  await app.until("document.querySelectorAll('#cpop-chat .cpop-it').length === 1", 'one prompt left');
  assert.equal(await app.evaluate("document.querySelector('#cpop-chat .cpop-it .hl').textContent"), 'notes');
  await app.key('Enter', 'Enter', 13);
  await app.until("!document.querySelector('#cpop-chat') && document.querySelector('#chat-input').value === 'Write the release notes'", 'the composer filled');
  assert.equal((await app.state()).chat.filter((c) => c.kind === 'user').length, 2);
  // Esc closes it and keeps the draft; with text in the composer Up is the caret's.
  await set('chat', '');
  await app.key('ArrowUp', 'ArrowUp', 38);
  await app.until("!!document.querySelector('#cpop-chat')", 'the history open for Esc');
  await set('chat', 'Run');
  await app.key('Escape', 'Escape', 27);
  await app.until("!document.querySelector('#cpop-chat')", 'closed by Esc');
  assert.equal(await app.evaluate("document.querySelector('#chat-input').value"), 'Run');
  await app.key('ArrowUp', 'ArrowUp', 38);
  assert.equal(await app.evaluate("!!document.querySelector('#cpop-chat')"), false);
  // A Worker's composer has its own history.
  await app.say('@fake task - Check the build\n@@fake result Done.');
  await app.until("(document.querySelectorAll('#chat-ins .res').length >= 1)", 'the task done');
  const wid = (await app.state()).workers[0].id;
  await app.click('#side [data-action="done-toggle"]');
  await app.until(`!!document.querySelector('#side [data-action="open-worker"][data-id="${wid}"]')`, 'the Worker in the sidebar');
  await app.click(`#side [data-action="open-worker"][data-id="${wid}"]`);
  await app.until("!!document.querySelector('#ws-form').offsetParent", 'the Worker conversation');
  await set('ws', '');
  await app.key('ArrowUp', 'ArrowUp', 38);
  await app.until("!!document.querySelector('#cpop-ws .cpop-none')", 'an empty history for the Worker');
});

flow('"/" at the start of a line lists the saved prompts and commands, and a prompt goes in with its preset chips', {}, async (app) => {
  const set = (v) => app.evaluate(`const i = document.querySelector('#chat-input'); i.focus(); i.value = ${JSON.stringify(v)}; i.setSelectionRange(i.value.length, i.value.length); i.dispatchEvent(new Event('input', { bubbles: true })); return 1;`);
  const rows = () => app.evaluate("return [...document.querySelectorAll('#cpop-chat .cpop-it')].map((r) => (r.classList.contains('on') ? '*' : '') + r.querySelector('span').textContent)");
  // None saved: the list says so and still offers saving what was typed and the commands.
  await set('/');
  await app.until("!!document.querySelector('#cpop-chat .cpop-none')", 'the empty list');
  assert.equal((await rows()).length, 3);
  await app.key('Escape', 'Escape', 27);
  // A prompt saved from the Memos tab's form, and one with a model saved through main.
  await app.click('#chat-ins [data-action="ins-tab"][data-v="memo"]');
  await app.click('#chat-ins [data-action="memo-seg"][data-v="prompt"]');
  await app.click('#chat-ins [data-action="prompt-new"]');
  await app.until("!!document.querySelector('#chat-ins [data-keep=\"prompt-name-new\"]')", 'the new prompt form');
  await app.evaluate(`for (const [k, v] of [['name', 'Review'], ['cmd', '/review'], ['text', 'Review the open PRs']]) document.querySelector('#chat-ins [data-keep="prompt-' + k + '-new"]').value = v; return 1;`);
  await app.click('#chat-ins [data-action="prompt-save"][data-id="new"]');
  await app.until("return (await window.ide.call('state')).prompts.length === 1", 'the prompt saved');
  await app.evaluate("return window.ide.call('prompt:add', { name: 'Release', cmd: 'release', text: '@fake task - Release', model: 'claude-sonnet-5-5', planFirst: true })");
  await app.until("document.querySelectorAll('#chat-ins .memo.prompt').length === 2", 'both cards');
  // A taken command is refused, and why shows under the list.
  await app.click('#chat-ins [data-action="prompt-new"]');
  await app.evaluate(`for (const [k, v] of [['name', 'Again'], ['cmd', 'review'], ['text', 'x']]) document.querySelector('#chat-ins [data-keep="prompt-' + k + '-new"]').value = v; return 1;`);
  await app.click('#chat-ins [data-action="prompt-save"][data-id="new"]');
  await app.until("!!document.querySelector('#chat-ins .ferr')", 'the taken command refused');
  await app.click('#chat-ins [data-action="prompt-cancel"]');
  // "/" lists both, then saving, then the commands; "/re" narrows and marks the match; "a /" opens nothing.
  await set('/');
  await app.until("document.querySelectorAll('#cpop-chat .cpop-it').length === 5", 'the full list');
  assert.deepEqual((await rows()).map((r) => r.replace(/^\*/, '')).slice(0, 2), ['/review', '/release']);
  assert.equal(await app.evaluate("document.querySelectorAll('#cpop-chat .cpop-h').length"), 2);
  await set('/rel');
  await app.until("document.querySelectorAll('#cpop-chat .cpop-it').length === 2", 'one prompt and saving');
  assert.equal(await app.evaluate("document.querySelector('#cpop-chat .cpop-it .hl').textContent"), '/rel');
  await set('/xyz');
  await app.until("!!document.querySelector('#cpop-chat .cpop-none')", 'no match');
  // Nothing matches, so no row is chosen and Enter sends the "/word" as it is.
  assert.equal(await app.evaluate("document.querySelectorAll('#cpop-chat .cpop-it.on').length"), 0);
  await app.key('Enter', 'Enter', 13);
  await app.until("return (await window.ide.call('state')).chat.some((c) => c.kind === 'user' && c.text === '/xyz')", 'the /xyz message sent');
  assert.equal(await app.evaluate("!document.querySelector('#cpop-chat') && document.querySelector('#chat-input').value === ''"), true);
  await set('a /re');
  await app.until("!document.querySelector('#cpop-chat')", 'closed after a space');
  // Enter puts the prompt in place of "/rel", with its model and plan first as chips; × drops one.
  await set('/rel');
  await app.until("document.querySelectorAll('#cpop-chat .cpop-it').length === 2", 'the list for Enter');
  await app.key('Enter', 'Enter', 13);
  await app.until("document.querySelector('#chat-input').value === '@fake task - Release'", 'the prompt in the composer');
  assert.equal(await app.evaluate("document.querySelectorAll('#chat-preset .pchip').length"), 2);
  await app.click('#chat-preset [data-action="preset-x"][data-k="planFirst"]');
  await app.until("document.querySelectorAll('#chat-preset .pchip').length === 1", 'plan first dropped');
  // Sent: the chips go with it and the task is made with the preset's model.
  await app.evaluate("document.querySelector('#chat-form').requestSubmit(); return 1;");
  await app.until("return (await window.ide.call('state')).tasks.some((t) => t.title === 'Release')", 'the task made');
  const s = await app.state();
  const task = s.tasks.find((x) => x.title === 'Release');
  assert.equal(s.workers.find((w) => w.id === task.workerId)?.model ?? task.model, 'claude-sonnet-5-5');
  assert.ok(!task.planFirst);
  assert.deepEqual(s.chat.find((c) => c.kind === 'user' && c.text === '@fake task - Release').preset, { repo: '', model: 'claude-sonnet-5-5', planFirst: false });
  assert.equal(await app.evaluate("document.querySelector('#chat-preset').hidden"), true);
});

flow('"@" after a space lists repositories and files, and the picked ones go as chips that Backspace removes', { repos: ['demo'] }, async (app) => {
  const set = (v) => app.evaluate(`const i = document.querySelector('#chat-input'); i.focus(); i.value = ${JSON.stringify(v)}; i.setSelectionRange(i.value.length, i.value.length); i.dispatchEvent(new Event('input', { bubbles: true })); return 1;`);
  const chips = () => app.evaluate("return [...document.querySelectorAll('#chat-preset .mchip')].map((c) => (c.classList.contains('on') ? '*' : '') + c.querySelector('.fn').textContent)");
  const repo = (await app.state()).repos[0].path;
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'settings.ts'), 'export {};\n');
  // Nothing typed: the repository, and no files yet.
  await set('@');
  await app.until("document.querySelector('#cpop-chat')?.dataset.kind === 'mentions' && document.querySelector('#cpop-chat .cpop-it')?.textContent.includes('demo')", 'the repository listed');
  assert.equal(await app.evaluate("[...document.querySelectorAll('#cpop-chat .cpop-h')].some((h) => h.textContent === 'Files')"), false);
  // Inside a word it does not open.
  await set('mail@sett');
  await app.until("!document.querySelector('#cpop-chat')", 'no list inside a word');
  // A file by its name, with its folder beside it; Enter makes it a chip and takes "@sett" out of the text.
  await set('look at @sett');
  await app.until("[...document.querySelectorAll('#cpop-chat .cpop-it')].some((r) => r.textContent.includes('settings.ts'))", 'the file listed');
  await app.key('Enter', 'Enter', 13);
  await app.until("document.querySelectorAll('#chat-preset .mchip').length === 1", 'the file chip');
  assert.equal(await app.evaluate("document.querySelector('#chat-input').value"), 'look at ');
  assert.equal(await app.evaluate("!document.querySelector('#cpop-chat')"), true);
  // Tab picks too; the same one twice is one chip.
  await set('look at @dem');
  await app.until("document.querySelector('#cpop-chat .cpop-it.on')?.textContent.includes('demo')", 'the repository chosen');
  await app.key('Tab', 'Tab', 9);
  await app.until("document.querySelectorAll('#chat-preset .mchip').length === 2", 'the repository chip');
  // Backspace at the start chooses the last chip (a ring), and again removes it.
  await app.evaluate("const i = document.querySelector('#chat-input'); i.focus(); i.setSelectionRange(0, 0); return 1;");
  await app.key('Backspace', 'Backspace', 8);
  assert.deepEqual(await chips(), ['settings.ts', '*demo']);
  await app.key('Backspace', 'Backspace', 8);
  await app.until("document.querySelectorAll('#chat-preset .mchip').length === 1", 'the chip removed');
  assert.equal(await app.evaluate("document.querySelector('#chat-input').value"), 'look at ');
  // Sent: the agent reads a "[Mentioned]" block; the thread shows it as chips over the bubble.
  await app.evaluate("document.querySelector('#chat-form').requestSubmit(); return 1;");
  await app.until("return (await window.ide.call('state')).chat.some((c) => c.kind === 'user' && c.text.includes('[Mentioned]'))", 'the message sent');
  const sent = (await app.state()).chat.find((c) => c.kind === 'user' && c.text.includes('[Mentioned]'));
  assert.equal(sent.text, 'look at\n\n[Mentioned]\n- file src/settings.ts — demo');
  await app.until("document.querySelector('#chat-thread .sent-chips .mchip')?.textContent === 'settings.ts'", 'the chip over the sent message');
  assert.equal(await app.evaluate("[...document.querySelectorAll('#chat-thread .bub.me')].some((b) => b.textContent.includes('[Mentioned]'))"), false);
  assert.equal(await app.evaluate("document.querySelector('#chat-preset').hidden"), true);
});
