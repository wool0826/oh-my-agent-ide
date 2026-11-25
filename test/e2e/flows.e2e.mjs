// End-to-end flows: the built app, fake agents (OMA_FAKE_AGENT), a stand-in for gh, and the real window.
// Each test starts the app on its own empty profile. Run with `npm run e2e`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { launch } from './harness.mjs';

/** Runs a flow against a fresh app and always stops it. */
function flow(name, opts, fn) {
  test(name, { timeout: 120_000 }, async () => {
    const app = await launch(opts);
    try { await fn(app); } finally { await app.stop(); }
  });
}

const task = (state, title) => state.tasks.find((x) => x.title === title);
const DEC = '#chat-ins .dec';
const answer = (val) => `${DEC} [data-action="answer"][data-val="${val}"]`;

flow('a permission is asked once, allowed for the task, and the result card has the file', {}, async (app) => {
  await app.say(['Write a note', '@fake task - Write a note', '@@fake permission npm install left-pad', '@@fake permission npm install is-odd',
    '@@fake write out/note.md hello', '@@fake file out/note.md', '@@fake result Wrote the note.'].join('\n'));
  await app.until(`!!document.querySelector('${DEC}')`, 'the permission card');
  assert.match(await app.evaluate(`document.querySelector('${DEC}').innerText`), /npm install left-pad/);
  await app.click(answer('allow-task'));
  await app.until("!!document.querySelector('#chat-ins .res')", 'the result card');
  const s = await app.state();
  const t = task(s, 'Write a note');
  assert.equal(t.status, 'done');
  assert.equal(t.summary, 'Wrote the note.');
  assert.equal(t.files.length, 1);
  assert.equal(s.decisions.filter((d) => d.status === 'pending').length, 0);
  // The second install was the same kind of action: it went ahead without a second card.
  const log = await app.workerLog(t.workerId);
  assert.match(log, /Allowed for this task: npm install/);
  assert.match(log, /Ran: npm install is-odd/);
});

flow('a URL in a result is a short link on the card and a link in its words', {}, async (app) => {
  await app.say('@fake task - Publish notes\n@@fake result Published [Release notes](https://claude.ai/artifact/abc123), see https://claude.ai/artifact/abc123 today.');
  await app.until("!!document.querySelector('#chat-thread .attach .links a[data-href=\"https://claude.ai/artifact/abc123\"]')", 'the artifact link on the result card');
  const card = await app.evaluate("[...document.querySelectorAll('#chat-thread .attach .links a')].map((a) => a.innerText).join('|')");
  assert.match(card, /^Release notes ↗\|Open W-\d+ conversation\|Reply$/);
  // In the words, the Markdown link reads its title and the bare URL is a link too.
  assert.equal(await app.evaluate("document.querySelector('#chat-thread .attach .sm').innerText"), 'Published Release notes, see https://claude.ai/artifact/abc123 today.');
  assert.equal(await app.evaluate("document.querySelectorAll('#chat-thread .attach .sm a[data-action=\"open-url\"]').length"), 2);
  await app.until("!!document.querySelector('#chat-ins .res .lk a[data-href=\"https://claude.ai/artifact/abc123\"]')", 'the artifact link on the inbox row');
});

flow('an always-ask rule offers no "Allow for this task", and a denial reaches the Worker', {}, async (app) => {
  await app.say('@fake task - Push it\n@@fake permission git push --force origin feature\n@@fake result Left the branch alone.');
  await app.until(`!!document.querySelector('${DEC}')`, 'the permission card');
  assert.equal(await app.evaluate(`!!document.querySelector('${answer('allow-task')}')`), false);
  assert.match(await app.evaluate(`document.querySelector('${DEC}').innerText`), /force push/i);
  await app.click(answer('deny'));
  await app.until("!!document.querySelector('#chat-ins .res')", 'the result card');
  const t = task(await app.state(), 'Push it');
  assert.match(await app.workerLog(t.workerId), /Not allowed: git push --force origin feature/);
});

flow('a question is answered with one of its options', {}, async (app) => {
  await app.say('@fake task - Split or not\n@@fake ask Split the PR in two? | Split | Keep as one\n@@fake result Went with the answer.');
  await app.until(`!!document.querySelector('${answer('Split')}')`, 'the question card with its options');
  await app.click(answer('Split'));
  await app.until("!!document.querySelector('#chat-ins .res')", 'the result card');
  const t = task(await app.state(), 'Split or not');
  assert.match(await app.workerLog(t.workerId), /Answer: Split/);
});

flow('decision cards take the keys: none is selected at first, Enter or ↓ selects, Enter allows, the next card gets the focus and a number picks', {}, async (app) => {
  await app.say('@fake task - Install one\n@@fake permission npm install a\n@@fake result Installed.\n@fake task - Pick one\n@@fake ask Which side? | Left | Right\n@@fake result Picked.');
  const CARD = `${DEC}[data-dec]`;
  await app.until(`document.querySelectorAll('${CARD}').length === 2`, 'both decision cards');
  // Nothing is selected and no card shows key hints; the first card is the list's one Tab stop.
  const look = () => app.evaluate(`const c = [...document.querySelectorAll('${CARD}')]; return c.map((x) => ({ sel: x.getAttribute('aria-current') === 'true', tab: x.tabIndex, focus: document.activeElement === x, perm: !!x.querySelector('[data-val="deny"]'), kbd: [...x.querySelectorAll('kbd')].some((k) => getComputedStyle(k).display !== 'none') }));`);
  let cards = await look();
  assert.deepEqual(cards.map((c) => [c.sel, c.tab, c.kbd]), [[false, 0, false], [false, -1, false]]);
  // The focus alone selects nothing, and Enter on a card that is not selected selects it instead of answering.
  await app.evaluate(`document.querySelector('${CARD}').focus(); return 1;`);
  cards = await look();
  assert.deepEqual(cards.map((c) => [c.sel, c.focus]), [[false, true], [false, false]]);
  await app.key('Enter', 'Enter', 13);
  cards = await look();
  assert.deepEqual(cards.map((c) => [c.sel, c.tab, c.kbd]), [[true, 0, true], [false, -1, false]]);
  assert.equal((await app.state()).decisions.filter((d) => d.status === 'pending').length, 2);
  await app.key('ArrowDown', 'ArrowDown', 40);
  cards = await look();
  assert.deepEqual(cards.map((c) => [c.sel, c.tab, c.focus, c.kbd]), [[false, -1, false, false], [true, 0, true, true]]);
  await app.key('ArrowUp', 'ArrowUp', 38);
  // Go to the permission card and allow it with Enter.
  if (!cards[0].perm) await app.key('ArrowDown', 'ArrowDown', 40);
  await app.key('Enter', 'Enter', 13);
  // The answered card goes; the question is selected and focused, and 2 picks its second option.
  await app.until(`document.querySelectorAll('${CARD}').length === 1 && document.activeElement === document.querySelector('${CARD}')`, 'the focus on the next card');
  await app.key('Digit2', '2', 50);
  await app.until(`document.querySelectorAll('#chat-ins .res').length === 2`, 'both result cards');
  const s = await app.state();
  assert.match(await app.workerLog(task(s, 'Install one').workerId), /Ran: npm install a/);
  assert.match(await app.workerLog(task(s, 'Pick one').workerId), /Answer: Right/);
  // Ctrl/Cmd+/ lists the keys; Escape closes the list.
  await app.key('Slash', '/', 191, process.platform === 'darwin' ? 4 : 2);
  await app.until("!!document.querySelector('#dlg:not([hidden]) .dlg.keys')", 'the shortcut list');
  assert.match(await app.evaluate("document.querySelector('.dlg.keys').innerText"), /D\b[\s\S]*1–9/);
  await app.key('Escape', 'Escape', 27);
  await app.until("document.querySelector('#dlg').hidden", 'the shortcut list closed');
});

flow('the sidebar tabs stay in view while the tab under them scrolls, and a redraw keeps the offset', {}, async (app) => {
  await app.evaluate("for (let i = 1; i <= 12; i++) await window.ide.call('memo:add', 'Memo number ' + i + ' with enough words to take two lines in a narrow sidebar'); return 1;");
  await app.click('[data-action="ins-tab"][data-v="memo"]');
  await app.until("document.querySelectorAll('#chat-ins .pk').length === 12", 'twelve memos');
  await app.size(1100, 420);
  const look = () => app.evaluate("const b = document.querySelector('#chat-ins .ins-body'), r = document.querySelector('#chat-ins').getBoundingClientRect(); return { tabs: document.querySelector('#chat-ins .ins-tabs').getBoundingClientRect().top - r.top, top: b.scrollTop, room: b.scrollHeight - b.clientHeight };");
  const before = await look();
  assert.ok(before.room > 0, 'the memos overflow the sidebar');
  await app.evaluate("const b = document.querySelector('#chat-ins .ins-body'); b.scrollTop = b.scrollHeight; return 1;");
  const after = await look();
  assert.ok(after.top > 0);
  assert.equal(after.tabs, before.tabs);
  // A state push draws the tab again: the list stays where it was scrolled to.
  await app.evaluate("await window.ide.call('memo:add', 'One more'); return 1;");
  await app.until("document.querySelectorAll('#chat-ins .pk').length === 13", 'the new memo');
  assert.ok((await look()).top > 0);
});

flow('from 560 wide the selected memo opens beside the list, and a draft keeps its text and caret across 560', {}, async (app) => {
  await app.evaluate("await window.ide.call('memo:add', 'Release notes go out on Thursdays'); await window.ide.call('memo:add', 'Prefer pnpm in new repositories'); return 1;");
  await app.click('[data-action="ins-tab"][data-v="memo"]');
  await app.until("document.querySelectorAll('#chat-ins .pk').length === 2", 'both memos');
  // The sidebar's width from its handle's keys: Home is 320, each Shift+← 64 wider.
  await app.size(1600);
  await app.evaluate("document.querySelector('#rz-ins').focus(); return 1;");
  const handle = async (code, vk, shift = false) => app.key(code, code, vk, shift ? 8 : 0);
  const where = () => app.evaluate(`const ta = document.querySelector('#chat-ins textarea[data-keep^="memo-"]:not(#memo-new)'); return {
    split: !!document.querySelector('#chat-ins .ins-cols.split'),
    detail: document.querySelector('#chat-ins .ins-detail')?.innerText ?? '',
    rows: [...document.querySelectorAll('#chat-ins .pk > .li')].filter((r) => r.offsetParent).length,
    inDetail: !!ta?.closest('.ins-detail'), value: ta?.value, focus: !!ta && document.activeElement === ta, caret: ta?.selectionStart };`);
  // One column at 320: no rows, no detail pane.
  await handle('Home', 36);
  await app.until("!document.querySelector('#chat-ins .ins-cols.split')", 'one column');
  assert.equal((await where()).rows, 0);
  // At 576 with nothing selected it stays one column; a click on a memo selects it, and the list becomes rows with
  // that memo in the detail pane; a row selects another one.
  for (let i = 0; i < 4; i++) await handle('ArrowLeft', 37, true);
  await app.until("parseFloat(document.querySelector('#win').style.getPropertyValue('--inspector-w')) === 576", 'the sidebar at 576');
  assert.equal((await where()).split, false);
  await app.click('#chat-ins .pk-c > .memo[data-action="pick"]');
  await app.until("!!document.querySelector('#chat-ins .ins-cols.split')", 'two panes');
  let w = await where();
  assert.equal(w.rows, 2);
  assert.match(w.detail, /Prefer pnpm|Release notes/);
  // Widest (End): the list keeps its width and the detail pane takes all the extra room.
  const cols = () => app.evaluate("const q = (s) => Math.round(document.querySelector(s).getBoundingClientRect().width); return [q('#chat-ins .ins-list'), q('#chat-ins .ins-detail')];");
  const [list576, detail576] = await cols();
  await app.evaluate("document.querySelector('#rz-ins').focus(); return 1;");
  await handle('End', 35);
  await app.until("parseFloat(document.querySelector('#win').style.getPropertyValue('--inspector-w')) > 800", 'the widest sidebar');
  const [listMax, detailMax] = await cols();
  assert.equal(listMax, list576);
  assert.ok(detailMax - detail576 > 200, `detail ${detail576} → ${detailMax}`);
  await handle('Home', 36);
  for (let i = 0; i < 4; i++) await handle('ArrowLeft', 37, true);
  await app.until("parseFloat(document.querySelector('#win').style.getPropertyValue('--inspector-w')) === 576", 'back to 576');
  const other = await app.evaluate("return [...document.querySelectorAll('#chat-ins .pk')].find((p) => !p.classList.contains('sel')).dataset.pick;");
  await app.click(`#chat-ins .li[data-id="${other}"]`);
  await app.until(`document.querySelector('#chat-ins .ins-detail .pk-c')?.dataset.from === '${other}'`, 'the other memo in the detail pane');
  // Edit it, type, and narrow the window so the sidebar gives way under 560, then widen it again: the same field
  // keeps its text, the focus and the caret.
  await app.click('#chat-ins .ins-detail [data-action="memo-edit"]');
  await app.until("document.activeElement?.matches('.ins-detail textarea')", 'the edit field');
  await app.evaluate("const ta = document.activeElement; ta.value = 'Draft that must survive'; ta.setSelectionRange(5, 5); return 1;");
  await app.size(1100);
  await app.until("!document.querySelector('#chat-ins .ins-cols.split')", 'one column again');
  w = await where();
  assert.deepEqual([w.inDetail, w.value, w.focus, w.caret], [false, 'Draft that must survive', true, 5]);
  await app.size(1600);
  await app.until("!!document.querySelector('#chat-ins .ins-cols.split')", 'two panes again');
  w = await where();
  assert.deepEqual([w.inDetail, w.value, w.focus, w.caret], [true, 'Draft that must survive', true, 5]);
  assert.match(await app.evaluate(`document.querySelector('#chat-ins .pk.sel > .li').innerText`), /editing/);
  // Selecting the other memo leaves the draft open and marked, not lost.
  await app.click(`#chat-ins .pk:not([data-pick="${other}"]) > .li`);
  await app.until(`document.querySelector('#chat-ins .ins-detail .pk-c')?.dataset.from !== '${other}'`, 'the first memo in the detail pane');
  assert.equal((await where()).value, 'Draft that must survive');
  assert.match(await app.evaluate(`document.querySelector('#chat-ins .pk[data-pick="${other}"] > .li').innerText`), /editing/);
  // Inbox in two panes: ↓ on the card in the detail pane selects the next decision, which takes the pane and the focus.
  await app.say('@fake task - Install one\n@@fake permission npm install a\n@@fake result Installed.\n@fake task - Pick one\n@@fake ask Which side? | Left | Right\n@@fake result Picked.');
  await app.click('[data-action="ins-tab"][data-v="inbox"]');
  await app.until("document.querySelectorAll('#chat-ins [data-dec]').length === 2", 'two decisions');
  // Nothing is selected, so the sidebar stays one column until a card is clicked.
  assert.equal(await app.evaluate("return !!document.querySelector('#chat-ins .ins-cols.split');"), false);
  await app.click('#chat-ins .dec[data-dec] .q');
  await app.until("!!document.querySelector('#chat-ins .ins-detail [data-dec]')", 'the clicked decision in the detail pane');
  const first = await app.evaluate("const c = document.querySelector('#chat-ins .ins-detail [data-dec]'); c.focus(); return c.dataset.dec;");
  await app.key('ArrowDown', 'ArrowDown', 40);
  const after = await app.evaluate("const c = document.querySelector('#chat-ins .ins-detail [data-dec]'); return { id: c?.dataset.dec, focus: document.activeElement === c, sel: document.querySelector('#chat-ins .pk.sel')?.dataset.pick };");
  assert.notEqual(after.id, first);
  assert.deepEqual([after.focus, after.sel], [true, after.id]);
});

flow('a memo keeps its lines: Shift+Enter is a new line, Enter adds it, and Enter saves an edit', {}, async (app) => {
  await app.click('[data-action="ins-tab"][data-v="memo"]');
  await app.until("!!document.querySelector('#memo-new')", 'the memo box');
  assert.equal(await app.evaluate("return document.querySelector('#memo-new').tagName;"), 'TEXTAREA');
  await app.evaluate("const ta = document.querySelector('#memo-new'); ta.focus(); ta.value = 'Release checklist\\n- bump the version\\n- tag it'; return 1;");
  // Shift+Enter leaves the text in the box; Enter adds the memo with all of its lines.
  await app.key('Enter', 'Enter', 13, 8);
  assert.equal(await app.evaluate("return document.querySelectorAll('#chat-ins [data-memo]').length;"), 0);
  await app.key('Enter', 'Enter', 13);
  await app.until("document.querySelectorAll('#chat-ins [data-memo]').length === 1", 'the memo');
  assert.equal(await app.evaluate("return document.querySelector('#chat-ins [data-memo] p').innerText;"), 'Release checklist\n- bump the version\n- tag it');
  assert.equal(await app.evaluate("return document.querySelector('#memo-new').value;"), '');
  // Editing (the memo is selected first: nothing is by default): Shift+Enter stays in the field, Enter saves the lines.
  await app.click('#chat-ins .memo[data-action="pick"]');
  await app.until("!!document.querySelector('#chat-ins [data-action=\"memo-edit\"]')", 'the memo selected');
  await app.click('#chat-ins [data-action="memo-edit"]');
  await app.until("document.activeElement?.matches('#chat-ins textarea[data-keep^=\"memo-\"]:not(#memo-new)')", 'the edit field');
  await app.evaluate("const ta = document.activeElement; ta.value = 'Release checklist\\n- tag it'; return 1;");
  await app.key('Enter', 'Enter', 13, 8);
  assert.ok(await app.evaluate("return !!document.querySelector('#chat-ins textarea:not(#memo-new)');"));
  await app.key('Enter', 'Enter', 13);
  await app.until("!document.querySelector('#chat-ins textarea:not(#memo-new)')", 'the edit saved');
  await app.until("document.querySelector('#chat-ins [data-memo] p')?.innerText === 'Release checklist\\n- tag it'", 'the saved lines');
});

flow('a saved script shows its command, runs only from its Run button into the chat, and is edited and deleted', {}, async (app) => {
  await app.click('[data-action="ins-tab"][data-v="script"]');
  await app.until("!!document.querySelector('#chat-ins [data-keep=\"script-name-new\"]')", 'the new script form');
  // Saving does not run it: nothing is in the chat until Run.
  await app.evaluate("document.querySelector('#chat-ins [data-keep=\"script-name-new\"]').value = 'Say hello'; const c = document.querySelector('#chat-ins [data-keep=\"script-cmd-new\"]'); c.value = 'echo first-line\\necho saved-script-ok'; c.focus(); return 1;");
  await app.key('Enter', 'Enter', 13);
  await app.until("document.querySelectorAll('#chat-ins .memo.script').length === 1", 'the saved script');
  assert.equal(await app.evaluate("return document.querySelector('#chat-ins .memo.script .script-cmd').innerText;"), 'echo first-line\necho saved-script-ok');
  assert.equal(await app.evaluate("return document.querySelectorAll('#chat-thread .sh-run').length;"), 0);
  assert.equal(await app.evaluate("return document.querySelector('#chat-ins [data-keep=\"script-name-new\"]').value;"), '');
  // Run: its block in the chat, named, with both lines' output.
  await app.click('#chat-ins .memo.script [data-action="script-run"]');
  await app.until("!!document.querySelector('#chat-thread .sh-run:not(.live)')", 'the run ended');
  const block = await app.evaluate("const b = document.querySelector('#chat-thread .sh-run'); return { name: b.querySelector('.sh-name')?.innerText, out: b.querySelector('.sh-out')?.innerText, code: b.querySelector('header code').innerText };");
  assert.equal(block.name, 'Say hello');
  assert.match(block.out, /first-line[\s\S]*saved-script-ok/);
  assert.match(block.code, /^echo first-line \+1 line$/);
  // Edit: the form holds what is saved; Enter in the name saves the change.
  await app.click('#chat-ins .memo.script [data-action="script-edit"]');
  await app.until("document.activeElement?.matches('#chat-ins [data-keep^=\"script-name-\"]:not([data-keep=\"script-name-new\"])')", 'the edit form');
  await app.evaluate("const n = document.activeElement; n.value = 'Say hi'; return 1;");
  await app.key('Enter', 'Enter', 13);
  await app.until("document.querySelector('#chat-ins .memo.script.open p')?.innerText === 'Say hi'", 'the renamed script');
  // Delete asks first.
  await app.click('#chat-ins .memo.script [data-action="script-remove"]');
  assert.equal(await app.evaluate("return document.querySelectorAll('#chat-ins .memo.script').length;"), 1);
  await app.click('#chat-ins .memo.script [data-action="script-remove"]');
  await app.until("!document.querySelector('#chat-ins .memo.script')", 'the script deleted');
});

flow('the side terminal runs lines apart from the chat, recalls them with the up arrow, clears and resizes', {}, async (app) => {
  // Ctrl+` opens it with its input focused.
  await app.key('Backquote', '`', 192, 2);
  await app.until("!document.querySelector('#tm').hidden && document.activeElement?.id === 'tm-input'", 'the open terminal');
  await app.evaluate("document.querySelector('#tm-input').value = 'echo side-terminal-ok'; return 1;");
  await app.key('Enter', 'Enter', 13);
  await app.until("[...document.querySelectorAll('#tm-thread .tm-run:not(.live) .tm-out')].some((o) => o.innerText.includes('side-terminal-ok'))", 'the output in the terminal');
  // Not in the chat.
  assert.equal(await app.evaluate("return document.querySelectorAll('#chat-thread .sh-run').length;"), 0);
  assert.equal(await app.evaluate("return document.querySelector('#tm-input').value;"), '');
  // ↑ brings the line back.
  await app.key('ArrowUp', 'ArrowUp', 38);
  assert.equal(await app.evaluate("return document.querySelector('#tm-input').value;"), 'echo side-terminal-ok');
  // The edge handles' arrows resize it, each in its own direction. The window is given a size first: the panel grows
  // only into the room it has, and a runner's window can be too narrow for one more step. It is back at its first
  // width once the new size has reached it.
  await app.size(1400, 900);
  await app.until("document.querySelector('#tm').offsetWidth === 560", 'the terminal at its first width in the wider window');
  const tbox = () => app.evaluate("const p = document.querySelector('#tm'); return { w: p.offsetWidth, h: p.offsetHeight };");
  const before = await tbox();
  await app.evaluate("document.querySelector('#tm-rz-w').focus(); return 1;");
  await app.key('ArrowRight', 'ArrowRight', 39, 8);
  await app.key('ArrowUp', 'ArrowUp', 38);
  assert.deepEqual(await tbox(), { w: before.w + 64, h: before.h });
  assert.equal(await app.evaluate("return document.querySelector('#tm-rz-w').getAttribute('aria-valuenow');"), String(before.w + 64));
  await app.evaluate("document.querySelector('#tm-rz-h').focus(); return 1;");
  await app.key('ArrowUp', 'ArrowUp', 38);
  await app.key('ArrowRight', 'ArrowRight', 39);
  assert.deepEqual(await tbox(), { w: before.w + 64, h: before.h + 16 });
  // Dragging the top edge's capsule up makes it taller and nothing else; the capsule is marked while it moves.
  const top = await app.evaluate("const r = document.querySelector('#tm-rz-h').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 3 };");
  await app.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: top.x, y: top.y, button: 'left', buttons: 1, clickCount: 1 });
  await app.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: top.x + 30, y: top.y - 40, button: 'left', buttons: 1 });
  assert.equal(await app.evaluate("return document.querySelector('#tm-rz-h').classList.contains('active') && !document.querySelector('#tm-rz-w').classList.contains('active');"), true);
  await app.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: top.x + 30, y: top.y - 40, button: 'left', buttons: 0, clickCount: 1 });
  assert.deepEqual(await tbox(), { w: before.w + 64, h: before.h + 56 });
  assert.equal(await app.evaluate("return document.querySelector('#tm-rz-h').classList.contains('active');"), false);
  // Clear empties it; Esc hides it and the chat input has the focus.
  await app.click('[data-action="tm-clear"]');
  await app.until("!document.querySelector('#tm-thread .tm-run')", 'the cleared terminal');
  await app.key('Escape', 'Escape', 27);
  await app.until("document.querySelector('#tm').hidden && document.activeElement?.id === 'chat-input'", 'the hidden terminal');
});

flow('a plan waits for approval before the work goes on', {}, async (app) => {
  await app.say('@fake task - Plan the change\n@@fake plan WHAT: rename the field\\nHOW: one commit\\nOUTPUT: a PR\n@@fake result Carried out the plan.');
  await app.until(`!!document.querySelector('${DEC}')`, 'the plan card');
  assert.equal((await app.state()).decisions.find((d) => d.status === 'pending').source, 'plan');
  await app.click(answer('allow'));
  await app.until("!!document.querySelector('#chat-ins .res')", 'the result card');
  const t = task(await app.state(), 'Plan the change');
  assert.match(await app.workerLog(t.workerId), /Plan approved\./);
});

flow('a failed turn fails its task', {}, async (app) => {
  await app.say('@fake task - Break\n@@fake say Trying\n@@fake fail The build is broken');
  const s = await app.until("return (await window.ide.call('state')).tasks.some((x) => x.status === 'failed') && (await window.ide.call('state'));", 'a failed task');
  assert.equal(task(s, 'Break').status, 'failed');
});

flow('a Worker whose turn failed is listed as stopped with an error, says where it stopped, and Continue reopens its task', {}, async (app) => {
  await app.say('@fake task - Break\n@@fake steps Read the code | Build it | Report\n@@fake step 1\n@@fake fail The build is broken');
  const s = await app.until("return (await window.ide.call('state')).tasks.some((x) => x.status === 'failed') && (await window.ide.call('state'));", 'a failed task');
  const t = task(s, 'Break');
  // The failed turn left the Worker idle; the sidebar, the chat and the Worker list still say it failed.
  assert.equal(s.workers.find((w) => w.id === t.workerId).status, 'idle');
  await app.until("document.querySelector('#side').innerText.includes('Stopped with an error')", 'the Worker under "Stopped with an error"');
  await app.until("!!document.querySelector('#chat-thread .attach.fail [data-action=\"worker-continue\"]')", 'the failure card with Continue');
  assert.match(await app.evaluate("document.querySelector('#chat-thread .attach.fail').innerText"), /W-\d+ · general · Stopped at 2\/3 · Build it · The build is broken/);
  await app.click('button[data-v="worker"]');
  const row = await app.evaluate("document.querySelector('#wk-list .wrow').innerText");
  assert.match(row, /Failed/);
  assert.match(row, /W-\d+ · general · Stopped at 2\/3 · Build it · The build is broken/);
  assert.doesNotMatch(row, /Idle|just now ago/);
  assert.match(await app.evaluate("document.querySelector('#wk-list .vhead small').innerText"), /^1 failed$/);
  // Continue is a button beside the row's own, and sends the Worker on: the task is reopened and finishes.
  assert.equal(await app.evaluate("!!document.querySelector('#wk-list [data-action=\"select-worker\"] [data-action=\"worker-continue\"]')"), false);
  await app.click('#wk-list [data-action="worker-continue"]');
  const done = await app.until("return (await window.ide.call('state')).tasks.every((x) => x.status === 'done') && (await window.ide.call('state'));", 'the task done after Continue');
  assert.equal(done.tasks.length, 1);
  await app.until("!document.querySelector('#side').innerText.includes('Stopped with an error') && !document.querySelector('#wk-list [data-action=\"worker-continue\"]')", 'the failure mark gone');
});

flow('with one slot, the second task waits and starts when the first ends', { settings: { maxWorkers: 1 } }, async (app) => {
  await app.say('@fake task - First\n@@fake permission npm run one\n@@fake result One.\n@fake task - Second\n@@fake permission npm run two\n@@fake result Two.');
  await app.until(`!!document.querySelector('${DEC}')`, "the first task's permission card");
  let s = await app.state();
  assert.equal(task(s, 'Second').status, 'queued');
  assert.equal(task(s, 'Second').queueReason, 'slot');
  // The queue says how full the slots are, the task's place in line and what starts it.
  const side = await app.evaluate("document.querySelector('#side').innerText");
  assert.match(side, /1\/1 slots/);
  assert.match(side, /next, when a slot frees/);
  assert.equal(await app.evaluate("document.querySelector('#side .q-row.next .q-pos')?.textContent"), '1');
  assert.equal(await app.evaluate("document.querySelectorAll('#side .q-slots i').length + ':' + document.querySelectorAll('#side .q-slots i.on').length"), '1:1');
  await app.click(answer('allow'));
  // The first finishes, the second takes the slot and asks in its turn.
  await app.until(`(document.querySelector('${DEC}')?.innerText ?? '').includes('npm run two')`, "the second task's permission card");
  await app.click(answer('allow'));
  s = await app.until("return (await window.ide.call('state')).tasks.every((x) => x.status === 'done') && (await window.ide.call('state'));", 'both tasks done');
  assert.equal(s.tasks.length, 2);
});

flow('a side question is asked and answered in its own panel, and reaches the Dispatcher only when sent over', {}, async (app) => {
  const before = await app.state();
  // Ctrl+J from the chat opens the panel with its input focused.
  await app.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyJ', key: 'j', ctrlKey: true, bubbles: true, cancelable: true })); return 1;");
  await app.until("!document.querySelector('#sq').hidden && document.activeElement?.id === 'sq-input'", 'the side question panel, focused');
  await app.evaluate("const i = document.querySelector('#sq-input'); i.value = 'What is 2 + 2?\\n@fake tokens 2000\\n@fake say It is 4.'; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#sq-form').requestSubmit(); return 1;");
  await app.until("document.querySelector('#sq-thread .bub.wk')?.innerText.includes('It is 4.')", 'the answer in the panel');
  await app.until("document.querySelector('#sq-ctx').innerText.includes('2K')", 'its own context meter');
  // The Dispatcher heard nothing: its chat and its context are as they were.
  const after = await app.state();
  assert.equal(after.chat.length, before.chat.length);
  assert.equal(after.dispatcher.contextTokens, before.dispatcher.contextTokens);
  assert.equal(await app.evaluate("document.querySelector('#chat-thread').innerText.includes('It is 4.')"), false);
  // "Send to the Dispatcher": the answer as a quote chip on the main composer; the panel goes behind its button.
  await app.click('#sq [data-action="sq-to-dispatcher"]');
  await app.until("!document.querySelector('#chat-reply').hidden && document.querySelector('#sq').hidden", 'the chip, and the panel minimised');
  const chip = await app.evaluate("const c = document.querySelector('#chat-reply'); return { who: c.querySelector('b').textContent, quote: c.querySelector('span').textContent, count: document.querySelector('#chat-sq i')?.textContent ?? '' };");
  assert.deepEqual(chip, { who: 'From a side question', quote: 'It is 4.', count: '2' });
  // Close forgets the thread.
  await app.click('#chat-sq');
  await app.click('#sq [data-action="sq-close"]');
  await app.until("document.querySelector('#sq').hidden && !document.querySelector('#chat-sq i')", 'the thread forgotten');
});

flow('the side question panel is resized from its edges and top-left corner by drag and by keys, and keeps its size', {}, async (app) => {
  // A window with room for the panel to grow, whatever the screen the test runs on.
  await app.size(1600, 1000);
  await app.click('#chat-sq');
  await app.until("!document.querySelector('#sq').hidden", 'the side question panel');
  const box = () => app.evaluate("const r = document.querySelector('#sq').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) };");
  const b0 = await box();
  // Drag the corner up and to the left: the panel grows that way and stays in its corner.
  const at = await app.evaluate("const r = document.querySelector('#sq .edge-rz.c').getBoundingClientRect(); return { x: r.left + 6, y: r.top + 6 };");
  await app.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', buttons: 1, clickCount: 1 });
  await app.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x - 60, y: at.y - 40, button: 'left', buttons: 1 });
  // From the corner both edges' capsules are marked.
  assert.equal(await app.evaluate("return [...document.querySelectorAll('#sq [role=separator]')].every((h) => h.classList.contains('active'));"), true);
  await app.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x - 120, y: at.y - 80, button: 'left', buttons: 1 });
  await app.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x - 120, y: at.y - 80, button: 'left', buttons: 0, clickCount: 1 });
  const b1 = await box();
  assert.deepEqual([b1.w - b0.w, b1.h - b0.h, b1.right, b1.bottom], [120, 80, b0.right, b0.bottom]);
  // The keys on the edges' handles, each its own direction: ← wider on the side one, ↓ shorter on the top one,
  // Shift by four steps; the other direction's arrows do nothing there.
  await app.evaluate("document.querySelector('#sq-rz-w').focus(); return 1;");
  await app.key('ArrowLeft', 'ArrowLeft', 37, 8);
  await app.key('ArrowDown', 'ArrowDown', 40);
  await app.evaluate("document.querySelector('#sq-rz-h').focus(); return 1;");
  await app.key('ArrowDown', 'ArrowDown', 40);
  await app.key('ArrowLeft', 'ArrowLeft', 37);
  const b2 = await box();
  assert.deepEqual([b2.w - b1.w, b2.h - b1.h], [64, -16]);
  assert.equal(await app.evaluate("return document.querySelector('#sq-rz-h').getAttribute('aria-valuenow');"), String(b2.h));
  // Dragging the side edge's capsule changes the width only.
  const side = await app.evaluate("const r = document.querySelector('#sq-rz-w').getBoundingClientRect(); return { x: r.left + 3, y: r.top + r.height / 2 };");
  await app.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: side.x, y: side.y, button: 'left', buttons: 1, clickCount: 1 });
  await app.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: side.x + 32, y: side.y - 50, button: 'left', buttons: 1 });
  await app.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: side.x + 32, y: side.y - 50, button: 'left', buttons: 0, clickCount: 1 });
  const b3 = await box();
  assert.deepEqual([b3.w - b2.w, b3.h - b2.h], [-32, 0]);
  assert.equal(await app.evaluate("localStorage.getItem('oma.sqSize')"), `${b3.w}x${b3.h}`);
  // Minimised and opened again, it keeps its size; a double-click goes back to its own size.
  await app.click('#chat-sq');
  await app.click('#chat-sq');
  await app.until("!document.querySelector('#sq').hidden", 'the panel again');
  assert.deepEqual(await box().then((b) => [b.w, b.h]), [b3.w, b3.h]);
  await app.evaluate("document.querySelector('#sq-rz-h').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return 1;");
  assert.equal((await box()).w, b0.w);
});

flow('the hand-outs of one turn fold into one block with a row per task', {}, async (app) => {
  await app.say('@fake task - One\n@@fake result One.\n@fake task - Two\n@@fake permission npm run two\n@@fake result Two.');
  await app.until("document.querySelectorAll('#chat-thread .hand .hrow').length === 2", 'one block with two rows');
  assert.equal(await app.evaluate("document.querySelectorAll('#chat-thread .hand').length"), 1);
  const rows = await app.evaluate("[...document.querySelectorAll('#chat-thread .hand .hrow b')].map((b) => b.textContent).join('|')");
  assert.equal(rows, 'One|Two');
  // While a task still asks, the block stays open; the header folds it by hand.
  await app.until(`!!document.querySelector('${DEC}')`, 'the permission card');
  assert.equal(await app.evaluate("document.querySelector('#chat-thread .hand-h').getAttribute('aria-expanded')"), 'true');
  await app.click('#chat-thread .hand-h');
  await app.until("document.querySelector('#chat-thread .hand-h').getAttribute('aria-expanded') === 'false'", 'the block folded');
  await app.click(answer('allow'));
  await app.until("return (await window.ide.call('state')).tasks.every((x) => x.status === 'done');", 'both tasks done');
});

flow('while the Dispatcher works, the composer has a status line with Stop and the Chat tab a dot', {}, async (app) => {
  await app.say('@fake wait 4000\n@fake say Done waiting.');
  await app.until("!document.querySelector('#chat-dstat').hidden", 'the status line');
  assert.match(await app.evaluate("document.querySelector('#chat-dstat').innerText"), /Dispatcher/);
  assert.equal(await app.evaluate("!!document.querySelector('#chat-dstat [data-action=\"chat-stop\"]')"), true);
  assert.equal(await app.evaluate("!!document.querySelector('#views button[data-v=\"chat\"].busy')"), true);
  await app.click('#chat-dstat [data-action="chat-stop"]');
  await app.until("document.querySelector('#chat-dstat').hidden && !document.querySelector('#views button[data-v=\"chat\"].busy')", 'the status line gone after Stop');
});

flow('a code task opens a PR, which is merged from the app', { repos: ['demo'] }, async (app) => {
  const url = 'https://github.com/o/demo/pull/1';
  await app.say(`@fake task demo Add a line\n@@fake write README.md # Demo\\nA line.\n@@fake commit Add a line\n@@fake pr ${url}\n@@fake result Added the line.`);
  await app.until("return (await window.ide.call('state')).tasks.some((x) => x.status === 'pr_open');", 'the task with its PR open');
  // Waiting for a review: the button is there, dimmed, says when it opens, and a click does nothing.
  await app.ghPr(url, { reviewDecision: 'REVIEW_REQUIRED' });
  await app.evaluate("await window.ide.call('pr:check'); return 1;");
  await app.until("!!document.querySelector('#chat-ins .prmerge.wait')", 'the Merge button, not ready yet');
  assert.deepEqual(await app.evaluate("const b = document.querySelector('#chat-ins .prmerge.wait'); return [b.getAttribute('aria-disabled'), b.dataset.tip, getComputedStyle(b).opacity];"), ['true', 'Merge opens once the PR is approved', '0.45']);
  await app.click('#chat-ins .prmerge.wait');
  assert.equal(await app.evaluate("!!document.querySelector('#chat-ins .prmerge.sure')"), false);
  // Approved: the same button opens.
  await app.ghPr(url, { reviewDecision: 'APPROVED' });
  await app.evaluate("await window.ide.call('pr:check'); return 1;");
  await app.until("!!document.querySelector('#chat-ins .prmerge:not(.wait)')", 'the Merge button');
  await app.click('#chat-ins .prmerge');
  await app.until("!!document.querySelector('#chat-ins .prmerge.sure')", 'the question before merging');
  await app.click('#chat-ins .prmerge.sure');
  const s = await app.until("return (await window.ide.call('state')).tasks.some((x) => x.prState === 'MERGED') && (await window.ide.call('state'));", 'the PR merged');
  assert.equal(task(s, 'Add a line').prState, 'MERGED');
  assert.ok(app.gh().calls.includes(`pr merge ${url} --squash`));
});

flow('a bundle across repositories is merged in the order its tasks were made', { repos: ['api', 'web'] }, async (app) => {
  const pr = (repo) => `https://github.com/o/${repo}/pull/1`;
  const one = (repo, title) => `@fake task ${repo} bundle=rename_field ${title}\n@@fake write README.md # ${repo}\\nRenamed.\n@@fake commit Rename\n@@fake pr ${pr(repo)}\n@@fake result Renamed.`;
  await app.say(`${one('api', 'Rename in the API')}\n${one('web', 'Rename in the web app')}`);
  await app.until("return (await window.ide.call('state')).tasks.filter((x) => x.status === 'pr_open').length === 2;", 'both PRs open');
  await app.evaluate("await window.ide.call('pr:check'); return 1;");
  await app.until("!!document.querySelector('[data-action=\"bundle-merge\"]')", '"Merge 2 in order"');
  assert.match(await app.evaluate("document.querySelector('[data-action=\"bundle-merge\"]').closest('.sect').innerText"), /Across repositories[\s\S]*rename field[\s\S]*api[\s\S]*web/);
  await app.click('[data-action="bundle-merge"]');
  await app.click('[data-action="bundle-merge"]');
  await app.until("return (await window.ide.call('state')).tasks.every((x) => x.prState === 'MERGED');", 'both PRs merged');
  const merges = app.gh().calls.filter((c) => c.startsWith('pr merge'));
  assert.deepEqual(merges, [`pr merge ${pr('api')} --squash`, `pr merge ${pr('web')} --squash`]);
});

flow('"Merge N" merges every ready PR from the sidebar', { repos: ['demo'] }, async (app) => {
  const one = (n) => `@fake task demo Change ${n}\n@@fake write file${n}.txt ${n}\n@@fake commit Change ${n}\n@@fake pr https://github.com/o/demo/pull/${n}\n@@fake result Changed ${n}.`;
  await app.say(`${one(1)}\n${one(2)}`);
  await app.until("return (await window.ide.call('state')).tasks.filter((x) => x.status === 'pr_open').length === 2;", 'both PRs open');
  await app.evaluate("await window.ide.call('pr:check'); return 1;");
  await app.until("!!document.querySelector('[data-action=\"pr-merge-all\"]')", '"Merge 2" in the sidebar');
  assert.equal(await app.evaluate("document.querySelector('[data-action=\"pr-merge-all\"]').textContent"), 'Merge 2');
  await app.click('[data-action="pr-merge-all"]');
  await app.click('[data-action="pr-merge-all"]');
  await app.until("return (await window.ide.call('state')).tasks.every((x) => x.prState === 'MERGED');", 'both PRs merged');
});

flow('a merged PR fires the automation set for merges', { repos: ['demo'] }, async (app) => {
  await app.evaluate("await window.ide.call('auto:add', 'After a merge\\n@fake say The automation ran.', { kind: 'merged' }); return 1;");
  await app.say('@fake task demo Small change\n@@fake write a.txt a\n@@fake commit Small change\n@@fake pr https://github.com/o/demo/pull/9\n@@fake result Changed.');
  await app.until("return (await window.ide.call('state')).tasks.some((x) => x.status === 'pr_open');", 'the PR open');
  await app.evaluate("await window.ide.call('pr:check'); return 1;");
  await app.until("!!document.querySelector('#chat-ins .prmerge')", 'the Merge button');
  await app.click('#chat-ins .prmerge');
  await app.click('#chat-ins .prmerge.sure');
  await app.until("document.querySelector('#chat-thread').innerText.includes('The automation ran.')", "the automation's turn in the chat");
});

flow('an automation is changed from its card: the form opens filled in, Cancel keeps it, Save updates it', {}, async (app) => {
  await app.evaluate("await window.ide.call('auto:add', 'Check the build\\nand say what broke', { kind: 'daily', time: '09:00', weekdays: false }); return 1;");
  const auto = "return (await window.ide.call('state')).automations[0]";
  const id = (await app.evaluate(auto)).id;
  await app.evaluate("await window.ide.call('auto:toggle', '" + id + "', false); return 1;");
  const before = await app.evaluate(auto);
  await app.click('#chat-ins [data-action="ins-tab"][data-v="auto"]');
  const slot = `#chat-ins .pk[data-pick="${id}"]`;
  await app.until(`!!document.querySelector('${slot}')`, 'the automation in the list');
  await app.click(`${slot} [data-action="pick"]`);
  await app.click(`${slot} [data-action="auto-edit"]`);
  // The form is the card, filled in with what the automation is, and the text has the focus.
  const form = `const f = document.querySelector('${slot} .auto-add'); return f && [f.querySelector('#auto-prompt-e').value, f.querySelector('#auto-time-e').value, f.querySelector('#auto-kind-e').value, f.querySelector('#auto-wk-e').checked, document.activeElement?.id];`;
  assert.deepEqual(await app.evaluate(form), ['Check the build\nand say what broke', '09:00', 'daily', false, 'auto-prompt-e']);
  // The form that adds one is still there, empty, with its own fields.
  assert.deepEqual(await app.evaluate("return [document.querySelectorAll('#auto-prompt').length, document.getElementById('auto-prompt').value, document.getElementById('auto-time').value]"), [1, '', '09:00']);
  // Cancel: nothing is saved and the card is back.
  await app.evaluate("document.getElementById('auto-prompt-e').value = 'Thrown away'; return 1;");
  await app.click(`${slot} [data-action="auto-edit-cancel"]`);
  await app.until(`!document.querySelector('${slot} .auto-add') && !!document.querySelector('${slot} [data-action="auto-edit"]')`, 'the card after Cancel');
  assert.deepEqual(await app.evaluate(auto), before);
  // A time that is not one is not saved, and what was typed stays.
  await app.click(`${slot} [data-action="auto-edit"]`);
  await app.evaluate("document.getElementById('auto-prompt-e').value = 'Check the tests\\nand the lint'; document.getElementById('auto-time-e').value = '25:00'; return 1;");
  await app.click(`${slot} [data-action="auto-save"]`);
  await app.until("[...document.querySelectorAll('#toasts .toast')].some((x) => x.innerText.includes('Write the time as 09:00.'))", 'the toast about the time');
  assert.deepEqual((await app.evaluate(form)).slice(0, 2), ['Check the tests\nand the lint', '25:00']);
  assert.deepEqual(await app.evaluate(auto), before);
  // Save: the text, its name, the time and the weekdays change; it stays switched off and keeps its id.
  await app.evaluate("document.getElementById('auto-time-e').value = '7:30'; return 1;");
  await app.click('#auto-wk-e');
  await app.click(`${slot} [data-action="auto-save"]`);
  await app.until(`!document.querySelector('${slot} .auto-add') && (document.querySelector('${slot} .memo')?.innerText ?? '').includes('Weekdays 07:30')`, 'the card after Save');
  const after = await app.evaluate(auto);
  assert.deepEqual([after.id, after.title, after.prompt, after.trigger, after.enabled, after.createdAt],
    [id, 'Check the tests', 'Check the tests\nand the lint', { kind: 'daily', time: '07:30', weekdays: true }, false, before.createdAt]);
  assert.notEqual(after.nextRunAt, before.nextRunAt);
  assert.match(await app.evaluate(`document.querySelector('${slot} .memo').innerText`), /Check the tests[\s\S]*Weekdays 07:30/);
  // To "When a PR merges": the time fades out in place, and the saved trigger has none.
  await app.click(`${slot} [data-action="auto-edit"]`);
  await app.click(`${slot} [data-segc="auto-kind-e"][data-v="merged"]`);
  assert.equal(await app.evaluate(`document.querySelector('${slot} .auto-add').classList.contains('merged')`), true);
  await app.click(`${slot} [data-action="auto-save"]`);
  await app.until("return (await window.ide.call('state')).automations[0].trigger.kind === 'merged'", 'the merged trigger');
  assert.equal((await app.evaluate(auto)).nextRunAt, null);
});

// Hours that hold the moment the flow runs (and pass midnight when they must), and hours that do not.
const hhmm = (h) => `${String((h + 24) % 24).padStart(2, '0')}:00`;
const hour = new Date().getHours();

flow('while do-not-disturb is on, a moon in the sidebar foot says until when and opens the alert settings', { settings: { quietFrom: hhmm(hour - 1), quietTo: hhmm(hour + 2) } }, async (app) => {
  const mark = "const m = document.getElementById('dnd-mark'); return [m.hidden, m.offsetWidth > 0, m.dataset.tip ?? '', m.getAttribute('aria-label') ?? ''];";
  const until = `Do not disturb until ${hhmm(hour + 2)}`;
  assert.deepEqual(await app.evaluate(mark), [false, true, until, until]);
  // Beside the gear, on the same line.
  assert.deepEqual(await app.evaluate("const g = document.querySelector('.side-foot [data-action=\"open-settings\"]').getBoundingClientRect(), m = document.getElementById('dnd-mark').getBoundingClientRect(); return [m.top === g.top, m.left >= g.right, m.left - g.right < 8];"), [true, true, true]);
  await app.click('#dnd-mark');
  await app.until("!!document.getElementById('set-qto')", 'the do-not-disturb fields in Settings');
  // Hours that are over: the mark goes when the settings are saved.
  await app.evaluate(`await window.ide.call('settings:save', { quietFrom: '${hhmm(hour + 3)}', quietTo: '${hhmm(hour + 4)}' }); return 1;`);
  await app.until("document.getElementById('dnd-mark').hidden", 'no mark outside the hours');
  await app.evaluate("await window.ide.call('settings:save', { quietFrom: '', quietTo: '' }); return 1;");
  assert.equal(await app.evaluate("document.getElementById('dnd-mark').hidden"), true);
});

flow('an error from the main process is said in the language of the window', { settings: { language: 'ko' } }, async (app) => {
  const fails = (js) => app.evaluate(`try { ${js}; return ''; } catch (e) { return String(e.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); }`);
  assert.equal(await fails("await window.ide.call('auto:add', '  ', { kind: 'merged' })"), '자동화가 할 일을 적어 주세요.');
  assert.equal(await fails("await window.ide.call('auto:add', 'x', { kind: 'daily', time: '99' })"), '시각은 09:00처럼 써 주세요.');
  assert.equal(await fails("await window.ide.call('auto:update', 'gone', 'x', { kind: 'merged' })"), '없는 항목이에요.');
  // Changing one to nothing is refused the same way, and it stays as it was.
  await app.evaluate("await window.ide.call('auto:add', 'Stays', { kind: 'merged' }); return 1;");
  const id = (await app.evaluate("return (await window.ide.call('state')).automations[0]")).id;
  assert.equal(await fails(`await window.ide.call('auto:update', '${id}', ' ', { kind: 'merged' })`), '자동화가 할 일을 적어 주세요.');
  assert.equal((await app.evaluate("return (await window.ide.call('state')).automations[0]")).prompt, 'Stays');
});

flow("replies to a report or a Dispatcher message are a thread: the chat shows the newest, the panel beside it the whole talk", {}, async (app) => {
  const send = (text) => app.evaluate(`const i = document.querySelector('#chat-input'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#chat-form').requestSubmit(); return 1;`);
  const inPanel = (text) => app.evaluate(`const i = document.querySelector('#thr-input'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#thr-form').requestSubmit(); return 1;`);
  const shown = (sel) => `!!document.querySelector(${JSON.stringify(sel)})?.getClientRects().length`;
  // The Worker reports after the Dispatcher's turn has ended, so nothing comes between the card and the reply.
  await app.say('@fake task - Write the notes\n@@fake wait 800\n@@fake result Wrote the notes.');
  const link = '#chat-thread .attach[data-task] [data-action="reply"]';
  await app.until(`!!document.querySelector(${JSON.stringify(link)})`, 'Reply on the result card');
  await app.click(link);
  await send('Why so short?\n@fake say The notes cover one change.');
  await app.until("document.querySelector('#chat-thread .tcard')?.innerText.includes('The notes cover one change.')", "the Dispatcher's answer on the card");
  // The card: the report, only the newest reply, then the count with the rest folded into "1 earlier". The question is
  // not a bubble of its own in the chat.
  const card = await app.evaluate("const g = document.querySelector('#chat-thread .tcard'); return { top: g.firstElementChild.dataset.task, rows: [...g.querySelectorAll('.t-row')].map((r) => r.querySelector('.who b').textContent), foot: g.querySelector('.t-foot').innerText.replace(/\\s+/g, ' ').trim(), loose: [...document.querySelectorAll('#chat-thread > .bub.me')].some((b) => b.innerText.includes('Why so short?')) };");
  assert.deepEqual(card, { top: 'T-0001', rows: ['Dispatcher'], foot: '2 replies 1 earlier Open thread', loose: false });
  // Open thread: the panel takes the right sidebar's place, with the root and every reply; its composer has the keys.
  await app.click('#chat-thread .tcard .t-open');
  await app.until(shown('#chat-thr'), 'the thread panel');
  const panel = await app.evaluate("const b = document.querySelector('#thr-body'); return { ins: !!document.querySelector('#chat-ins').getClientRects().length, title: document.querySelector('#thr-title').textContent, root: b.querySelector('.thr-root').innerText.includes('Write the notes'), rows: [...b.querySelectorAll(':scope > .t-row')].map((r) => r.querySelector('.who b').textContent), focus: document.activeElement?.id, ringed: document.querySelector('#chat-thread .tcard').classList.contains('thr-on') };");
  assert.deepEqual(panel, { ins: false, title: 'Thread · Write the notes', root: true, rows: ['You', 'Dispatcher'], focus: 'thr-input', ringed: true });
  // A message written in the panel is a reply in that thread, and so is the Dispatcher's answer.
  await inPanel('And the tests?\n@fake say They pass.');
  await app.until("document.querySelector('#thr-body')?.innerText.includes('They pass.')", 'the answer in the panel');
  await app.until("document.querySelector('#chat-thread .tcard .t-foot')?.innerText.includes('4 replies')", 'the count on the card');
  assert.equal(await app.evaluate("document.querySelector('#chat-thread .tcard .t-row').innerText.includes('They pass.')"), true, 'the newest reply on the card');
  // The keys: ↑ from the empty composer to the newest reply, ↑ again to the one before; Esc closes the panel and the
  // keyboard goes back to the thread in the chat.
  await app.evaluate("document.querySelector('#thr-input').focus(); return 1;");
  await app.key('ArrowUp', 'ArrowUp', 38);
  await app.key('ArrowUp', 'ArrowUp', 38);
  assert.equal(await app.evaluate("document.activeElement?.matches('#thr-body > .t-row.me') && document.activeElement.innerText.includes('And the tests?')"), true);
  await app.key('Escape', 'Escape', 27);
  await app.until(`!(${shown('#chat-thr')})`, 'the panel closed');
  assert.deepEqual(await app.evaluate("return [!!document.querySelector('#chat-ins').getClientRects().length, document.activeElement?.matches('#chat-thread .tcard .t-open') ?? false];"), [true, true]);
  const filed = (await app.state()).chat.filter((c) => c.replyTo).map((c) => [c.kind, c.replyTo]);
  assert.deepEqual(filed, [['user', 'T-0001'], ['dispatcher', 'T-0001'], ['user', 'T-0001'], ['dispatcher', 'T-0001']]);

  // A thread on a Dispatcher message, from its "Reply in thread" button: the chat shows a chip under the bubble.
  await app.say('Something else\n@fake say Something else answered.');
  const bline = "[...document.querySelectorAll('#chat-thread > .bline')].find((b) => b.innerText.includes('Something else answered.'))";
  await app.until(`!!${bline}`, 'the plain answer');
  await app.evaluate(`${bline}.querySelector('[data-action="thread-open"]').click(); return 1;`);
  await app.until("document.querySelector('#thr-title')?.textContent === 'Thread · Dispatcher'", 'the panel on the message');
  await inPanel('Thanks\n@fake say Any time.');
  await app.until(`${bline}?.nextElementSibling?.matches('.t-chip') && ${bline}.nextElementSibling.innerText.includes('Any time.')`, 'the chip under the bubble');
  const root = (await app.state()).chat.find((c) => c.text === 'Something else answered.').id;
  assert.deepEqual((await app.state()).chat.filter((c) => c.replyTo === root).map((c) => c.kind), ['user', 'dispatcher']);
  await app.key('Escape', 'Escape', 27);

  // A reply to the report after other messages: a chip where it came that names the report. Of the answers, the
  // newest is on the chip; the one before it counts as new until the thread is opened.
  await app.click(link);
  await send('Any more?\n@fake say One more thing.\n@fake say Not now.');
  await app.until("document.querySelector('#chat-thread > .t-chip.late')?.innerText.includes('Not now.')", 'the late chip');
  const late = await app.evaluate("const c = document.querySelector('#chat-thread > .t-chip.late'); return { name: c.querySelector('.t-name').textContent, fresh: c.querySelector('.t-new')?.textContent ?? '', last: c === document.querySelector('#chat-thread').lastElementChild || !c.nextElementSibling?.matches('.bub, .bline, .tcard') };");
  assert.deepEqual(late, { name: 'Write the notes', fresh: '1 new', last: true });
  await app.click('#chat-thread > .t-chip.late');
  await app.until("document.querySelector('#thr-title')?.textContent === 'Thread · Write the notes'", 'the panel on the report');
  await app.until("!document.querySelector('#chat-thread .t-new')", 'nothing new once opened');

  // T on a message in the chat opens its thread; the side question floats over the chat, clear of the panel.
  await app.key('Escape', 'Escape', 27);
  await app.evaluate(`const b = ${bline}; b.tabIndex = -1; b.focus(); return 1;`);
  await app.key('KeyT', 't', 84);
  await app.until("document.querySelector('#thr-title')?.textContent === 'Thread · Dispatcher'", 'T opened the thread');
  await app.click('#chat-sq');
  await app.until("!document.querySelector('#sq').hidden", 'the side question');
  const apart = await app.evaluate("const a = document.querySelector('#sq').getBoundingClientRect(), b = document.querySelector('#chat-thr').getBoundingClientRect(); return a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;");
  assert.equal(apart, true, 'the side question and the panel do not overlap');
  await app.click('#sq [data-action="sq-close"]');
  // With the right sidebar put away, a thread brings it out, and closing the thread puts it away again.
  await app.click('[data-action="thread-close"]');
  await app.click('#ins-toggle');
  await app.until("document.querySelector('#win').classList.contains('ins-min')", 'the sidebar put away');
  await app.click('#chat-thread > .t-chip.late');
  await app.until(`!document.querySelector('#win').classList.contains('ins-min') && ${shown('#chat-thr')}`, 'the panel out');
  await app.click('[data-action="thread-close"]');
  await app.until("document.querySelector('#win').classList.contains('ins-min')", 'the sidebar away again');
});

flow('a line run with ! shows its output in the chat; with the reply chip off, the Dispatcher gets it with its next turn', {}, async (app) => {
  const typeIn = (value) => app.evaluate(`const i = document.querySelector('#chat-input'); i.focus(); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input', { bubbles: true })); return 1;`);
  const shellMode = () => app.evaluate("document.querySelector('#chat-form').classList.contains('shell')");
  // "!" first: shell mode, and the "!" leaves the text. Esc goes back to a message.
  await typeIn('!');
  assert.equal(await shellMode(), true);
  assert.equal(await app.evaluate("document.querySelector('#chat-input').value"), '');
  await app.evaluate("document.querySelector('#chat-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); return 1;");
  assert.equal(await shellMode(), false);

  await typeIn('!node -e "console.log(41 + 1)"');
  assert.equal(await shellMode(), true);
  // The chip on the bar: on by default; off, the result waits for the next message, and the setting is saved.
  assert.equal(await app.evaluate("document.querySelector('#chat-shbar .sh-ask').getAttribute('aria-pressed')"), 'true');
  await app.click('#chat-shbar .sh-ask');
  assert.equal(await app.evaluate("document.querySelector('#chat-shbar .sh-ask').getAttribute('aria-pressed')"), 'false');
  await app.until("return (await window.ide.call('state')).settings.shellAsk === false;", 'the setting saved');
  await app.evaluate("document.querySelector('#chat-form').requestSubmit(); return 1;");
  await app.until("document.querySelector('#chat-thread .sh-run')?.innerText.includes('Exit 0')", 'the run block with Exit 0');
  const block = await app.evaluate("const b = document.querySelector('#chat-thread .sh-run'); return { cmd: b.querySelector('code').textContent, out: b.querySelector('.sh-out')?.textContent ?? '', dlv: b.querySelector('.sh-dlv').className, said: b.querySelector('.sh-dlv').textContent };");
  assert.equal(block.cmd, 'node -e "console.log(41 + 1)"');
  assert.match(block.out, /42/);
  assert.match(block.dlv, /wait/, 'waits for the Dispatcher');
  assert.equal(block.said, "Waiting for the Dispatcher's turn");
  assert.equal(await shellMode(), false, 'a run leaves shell mode');

  // No turn of its own: it goes with the next message.
  await app.say('What did it print?\n@fake echo [Shell run]');
  await app.until("[...document.querySelectorAll('#chat-thread .bub.ai')].some((b) => b.innerText.includes('[Shell run] The user ran'))", 'the run in what the Dispatcher received');
  await app.until("!!document.querySelector('#chat-thread .sh-run .sh-dlv.ok')", '"The Dispatcher has it"');
  const said = await app.evaluate("[...document.querySelectorAll('#chat-thread .bub.ai')].map((b) => b.innerText).join('\\n')");
  // The bubble draws the command's backticks as code.
  assert.match(said, /\[Shell run\] The user ran node -e "console\.log\(41 \+ 1\)" in the IDE home: exit 0/);
});

flow('a line run with ! hands its result to the Dispatcher, which replies without being asked', {}, async (app) => {
  const line = `!node -e "console.log('@fake echo handed you')"`;
  await app.evaluate(`const i = document.querySelector('#chat-input'); i.focus(); i.value = ${JSON.stringify(line)}; i.dispatchEvent(new Event('input', { bubbles: true })); return 1;`);
  assert.equal(await app.evaluate("document.querySelector('#chat-shbar .sh-ask').getAttribute('aria-pressed')"), 'true');
  await app.evaluate("document.querySelector('#chat-form').requestSubmit(); return 1;");
  // The Dispatcher's turn starts by itself, with the run's result and what to do with it.
  await app.until("[...document.querySelectorAll('#chat-thread .bub.ai')].some((b) => b.innerText.includes('handed you its result'))", "the Dispatcher's turn for the run");
  await app.until("!!document.querySelector('#chat-thread .sh-run .sh-dlv.ok')", '"The Dispatcher has it"');
  const st = await app.state();
  assert.equal(st.chat.filter((c) => c.kind === 'user').length, 0, 'the user typed nothing');
  assert.equal(st.chat.find((c) => c.kind === 'shell')?.shell?.ask, true);
  // One turn, not more: the Dispatcher cannot run "!" itself, so nothing starts another.
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(await app.evaluate("document.querySelectorAll('#chat-thread .bub.ai').length"), 1);
});

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

flow('an issue of a repository is handed to the Dispatcher', {
  repos: ['demo'],
  gh: { issues: [{ number: 12, title: 'Tax is rounded twice', url: 'https://github.com/o/demo/issues/12', labels: [{ name: 'bug' }], updatedAt: '2026-11-20T00:00:00Z' }] },
}, async (app) => {
  await app.click('button[data-v="repo"]');
  await app.click('#repo-main [data-action="repo-select"]');
  await app.until("!!document.querySelector('[data-action=\"issue-assign\"]')", 'the issue with its Assign button');
  assert.match(await app.evaluate("document.querySelector('.mini.issue').innerText"), /#12 Tax is rounded twice[\s\S]*bug/);
  await app.click('[data-action="issue-assign"]');
  await app.until("document.querySelector('#chat-thread').innerText.includes('Work on issue #12: Tax is rounded twice')", 'the message in the chat');
});

const savedTask = { id: 'T-0001', title: 'Kept in the backup', prompt: '', kind: 'other', repo: null, workerId: null, status: 'done', branch: null, prUrl: null, prState: null,
  summary: 'From the backup.', files: [], createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', finishedAt: '2026-11-01T00:00:00Z', reviewSyncedAt: null, seenCommentIds: [] };

flow('an unreadable state file is set aside and the newest backup is put back', {
  files: {
    'data/state.json': '{"tasks":[{"id":"T-00',
    'data/backups/state-2026-11-01.json': JSON.stringify({ counters: { worker: 0, task: 1 }, tasks: [savedTask] }),
    'data/backups/state-2026-11-02.json': 'also broken',
  },
}, async (app) => {
  const s = await app.state();
  assert.deepEqual(s.tasks.map((x) => x.title), ['Kept in the backup']);
  assert.match(await app.evaluate("document.querySelector('#chat-thread').innerText"), /the backup of 2026-11-01 was put back/);
  const data = fs.readdirSync(path.join(app.home, 'data'));
  assert.ok(data.some((n) => /^state-broken-\d+\.json$/.test(n)), `the unreadable file was not kept: ${data.join(', ')}`);
  // Today's copy was made at launch, from the state that was put back.
  const today = fs.readdirSync(path.join(app.home, 'data', 'backups')).sort().at(-1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(app.home, 'data', 'backups', today), 'utf8')).tasks.map((x) => x.title), ['Kept in the backup']);
});

flow('an allowance for a task is kept on the task and can be taken back', {}, async (app) => {
  await app.say('@fake task - Install twice\n@@fake permission npm install a\n@@fake wait 1500\n@@fake permission npm install b\n@@fake result Installed.');
  await app.until(`!!document.querySelector('${DEC}')`, 'the first permission card');
  await app.click(answer('allow-task'));
  let s = await app.until("return (await window.ide.call('state')).tasks.some((x) => x.grants?.length) && (await window.ide.call('state'));", 'the allowance on the task');
  const t = task(s, 'Install twice');
  assert.deepEqual(t.grants, [{ key: 'bash:npm install', label: 'npm install' }]);
  // Taken back while the Worker is between the two installs: the second one asks again.
  await app.click('button[data-v="worker"]');
  await app.click(`#wk-list [data-id="${t.workerId}"]`);
  await app.until("!!document.querySelector('[data-action=\"grant-revoke\"]')", 'the allowance in the Worker view');
  await app.click('[data-action="grant-revoke"]');
  s = await app.until("return (await window.ide.call('state')).decisions.some((d) => d.status === 'pending') && (await window.ide.call('state'));", 'the second permission asked again');
  assert.deepEqual(task(s, 'Install twice').grants, []);
  assert.match(s.decisions.find((d) => d.status === 'pending').code, /npm install b/);
});

flow('Settings shows what is missing on this computer and the command that fixes it', {
  settings: { githubHost: 'github.company.com' },
  gh: { signedOut: ['github.company.com'] },
}, async (app) => {
  // The launch check puts a dot on the gear without Settings being opened.
  await app.until("document.querySelector('.side-foot [data-action=\"open-settings\"]').classList.contains('has-issue')", 'the dot on the gear');
  await app.click('[data-action="open-settings"]');
  await app.click('[data-action="pane"][data-id="general"]');
  await app.until("document.querySelectorAll('#pre-rows .pill').length >= 4", 'the status rows');
  const rows = await app.evaluate("[...document.querySelectorAll('#pre-rows .srow')].map((r) => r.innerText.replace(/\\s+/g, ' ').trim())");
  // What failed comes first, with why and its command; the rest are fine. Fake agents need no account.
  assert.match(rows[0], /^GitHub sign-in: github\.company\.com Installed, but not signed in\. Run: gh auth login --hostname github\.company\.com Needed$/);
  assert.deepEqual(rows.slice(1).map((r) => r.replace(/ OK$/, '')), ['git', 'GitHub CLI (gh)', 'GitHub sign-in: github.com', 'IDE home folder']);
  assert.equal((await app.state()).preflightFailed, 1);
});

flow('the diagnostics report describes the app and holds no secrets', {
  settings: { githubHost: 'github.company.com', jiraUrl: 'https://company.atlassian.net', jiraEmail: 'me@company.com', jiraTokenEnc: 'raw:c2VjcmV0LXRva2Vu' },
  // The company host is signed out, so its name is in a failed check's own words too.
  gh: { signedOut: ['github.company.com'] },
}, async (app) => {
  await app.say('@fake task - Note for the report\n@@fake result Done.');
  await app.until("!!document.querySelector('#chat-ins .res')", 'the result card');
  const text = await app.evaluate("return await window.ide.call('diag:text');");
  assert.match(text, /^Oh My Agent IDE diagnostics, /);
  assert.match(text, /\[app\][\s\S]*version: \d+\.\d+\.\d+[\s\S]*fake: true/);
  assert.match(text, /\[checks\][\s\S]*ok {3}git/);
  assert.match(text, /FAIL ghAuth \(company host\): You are not logged into any GitHub hosts on <company-github>\./);
  assert.match(text, /tasks: \{"done":1\}/);
  assert.match(text, /jiraUrl set: true/);
  assert.match(text, /\[log\][\s\S]*INFO boot/);
  assert.doesNotMatch(text, /company\.com|atlassian|me@|c2VjcmV0|secret-token/);
  // The button is where it is said to be.
  await app.click('[data-action="open-settings"]');
  await app.click('[data-action="pane"][data-id="general"]');
  assert.equal(await app.evaluate("document.querySelector('[data-action=\"diag-export\"]')?.textContent"), 'Save report…');
});

flow('the appearance follows the setting, at once and after a restart of the page', {}, async (app) => {
  const canvas = () => app.evaluate("getComputedStyle(document.body).backgroundColor + ' | ' + document.documentElement.dataset.theme");
  assert.match(await canvas(), /dark$/);
  const dark = (await canvas()).split(' | ')[0];
  await app.click('[data-action="open-settings"]');
  await app.click('[data-action="pane"][data-id="display"]');
  await app.click('button[data-segc="set-theme"][data-v="light"]');
  await app.until("document.documentElement.dataset.theme === 'light'", 'the light theme on the page');
  const light = (await canvas()).split(' | ')[0];
  assert.notEqual(light, dark);
  // Saved, not only shown.
  await app.until("return (await window.ide.call('state')).settings.theme === 'light';", 'the setting saved');
});

flow('the palette finds something said and shows the chat from that message', {}, async (app) => {
  await app.say('Please remember the pineapple rule\n@fake say Noted: no pineapple on Fridays.');
  await app.until("document.querySelector('#chat-thread').innerText.includes('no pineapple on Fridays')", "the Dispatcher's answer");
  // Enough later messages that the first is not what the chat opens on.
  for (let i = 0; i < 3; i++) await app.say(`Filler ${i}\n@fake say Filler answer ${i}.`);
  await app.until("document.querySelector('#chat-thread').innerText.includes('Filler answer 2.')", 'the later messages');
  // Ctrl+F opens the palette to find something said.
  await app.evaluate("document.querySelector('#chat-input').focus(); return 1;");
  await app.key('KeyF', 'f', 70, 2);
  await app.until("document.activeElement?.id === 'cmdk-q'", 'the palette opened by Ctrl+F');
  await app.evaluate("const q = document.querySelector('#cmdk-q'); q.value = 'pineapple fridays'; q.dispatchEvent(new Event('input', { bubbles: true })); return 1;");
  const row = await app.until("[...document.querySelectorAll('.cmdk-it')].findIndex((el) => el.innerText.includes('no pineapple on Fridays')) + 1", 'the message among the results');
  // The blink is for a screen that allows motion (a CI runner may ask for less).
  await app.cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await app.click(`#cmdk-${row - 1}`);
  // Read in the same look that finds it: the bubble blinks, and the mark is taken off again a moment later.
  const found = await app.until("const f = document.querySelector('#chat-thread .found'); return f && JSON.stringify({ text: f.innerText, bub: f.matches('.bub'), blink: f.getAnimations().some((a) => a.animationName === 'found') });", 'the message marked in the chat');
  const mark = JSON.parse(found);
  assert.match(mark.text, /no pineapple on Fridays/);
  assert.deepEqual([mark.bub, mark.blink], [true, true]);
  // The thread now starts at that message: what was said before it is above, not shown.
  assert.equal(await app.evaluate("document.querySelector('#chat-thread').innerText.includes('Please remember the pineapple rule')"), false);
  await app.until("!document.querySelector('#chat-thread .found')", 'the mark taken off', 8000);
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

flow('do-not-disturb hours are set in Settings and kept as times', {}, async (app) => {
  await app.click('[data-action="open-settings"]');
  await app.click('[data-action="pane"][data-id="alerts"]');
  // Typing marks what is not a time, for the eye and for a screen reader; leaving the field shows what is kept.
  const type = (id, v) => app.evaluate(`const el = document.getElementById(${JSON.stringify(id)}); el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event('input', { bubbles: true })); return el.classList.contains('bad') + '/' + el.getAttribute('aria-invalid');`);
  const leave = (id) => app.evaluate(`const el = document.getElementById(${JSON.stringify(id)}); el.dispatchEvent(new Event('change', { bubbles: true })); return el.value + '|' + el.classList.contains('bad') + '/' + el.getAttribute('aria-invalid');`);
  assert.equal(await type('set-qfrom', 'late'), 'true/true');
  assert.equal(await leave('set-qfrom'), '|false/null');
  assert.equal(await type('set-qfrom', '22'), 'false/null');
  assert.equal(await leave('set-qfrom'), '22:00|false/null');
  // One time alone switches nothing on: the empty side is marked, and its placeholder does not read as a time.
  assert.equal(await app.evaluate("const el = document.getElementById('set-qto'); return el.placeholder + '|' + el.getAttribute('aria-invalid');"), '--:--|true');
  // A slip of the hand does not switch the hours off: the time in use comes back.
  assert.equal(await type('set-qfrom', '22:6x'), 'true/true');
  assert.equal(await leave('set-qfrom'), '22:00|false/null');
  assert.equal(await type('set-qto', '7:30'), 'false/null');
  assert.equal(await leave('set-qto'), '07:30|false/null');
  // "Notify when a task ends" is off here: its sound cannot be chosen or tried until the switch is on.
  const dsound = "return [...document.querySelectorAll('.dsound-row button')].map((b) => b.disabled).join() + '|' + document.querySelector('.dsound-row').classList.contains('off');";
  assert.match(await app.evaluate(dsound), /^true(,true)+\|true$/);
  await app.click('#set-nres');
  assert.match(await app.evaluate(dsound), /^false(,false)+\|false$/);
  const s = await app.until("return (await window.ide.call('state')).settings.quietTo === '07:30' && (await window.ide.call('state'));", 'the hours saved');
  assert.equal(s.settings.quietFrom, '22:00');
  // The harness saves the old `notifications: false`, which turns task-end notifications off too (notifyDoneFrom); the click turns them on.
  assert.equal(s.settings.notifyDone, true);
  assert.equal(s.settings.notifications, false);
});

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

{
  const at = (mins) => new Date(Date.now() + mins * 60_000).toISOString();
  const win = (utilization, resetsAt) => ({ utilization, resetsAt });
  const acc = (id, label, x) => ({ id, label, kind: 'token', plan: 'team', provider: 'claude', tokenEnc: '', planLabel: null, windowMins: null, usageSource: 'probe', limitedUntil: null, lastAssignedAt: null, lastError: null, usageBackoffUntil: null, usageUpdatedAt: at(-2), ...x });
  const accounts = [
    acc('a', 'Team A', { fiveHour: win(86, at(70)), sevenDay: win(41, at(4500)) }),
    acc('b', 'Team B', { fiveHour: win(42, at(125)), sevenDay: win(100, at(1800)), limitedUntil: at(1800) }),
    acc('c', 'Team C', { fiveHour: win(20, at(200)), sevenDay: win(null, null), lastError: 'Usage lookup failed (500)', usageUpdatedAt: at(-26) }),
  ];
  flow('the usage widget shows rings alone, says when a used-up account resets, and its popover says when it refreshes and refreshes by hand', { settings: { accounts, usageRefreshMins: 15 } }, async (app) => {
    await app.until("document.querySelectorAll('#usage .uacct').length === 3", 'the rings');
    // The toolbar: no figures in words; only the used-up account says when it resets; a failed read marked.
    assert.deepEqual(await app.evaluate("[...document.querySelectorAll('#usage .uacct')].map((u) => [!!u.querySelector('.ulim'), u.classList.contains('limited'), u.classList.contains('failed')])"),
      [[false, false, false], [true, true, false], [false, false, true]]);
    assert.match(await app.evaluate("document.querySelector('#usage .ulim').textContent"), /^Resets in 1d [56]h$/);
    assert.doesNotMatch(await app.evaluate("document.querySelector('#usage').textContent"), /%/);
    // The popover, with the foot: the last round, one of three failed, the interval chosen.
    await app.evaluate("document.querySelector('#usage .uacct').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); return 1;");
    await app.until("!document.querySelector('#usage-pop').hidden && !!document.querySelector('#usage-pop .ufoot')", 'the popover foot');
    assert.match(await app.evaluate("document.querySelector('#usage-pop .uft').textContent"), /^Updated .* · 1 of 3 failed$/);
    assert.equal(await app.evaluate("document.querySelector('#usage-pop [data-segc=\"usage-every\"][aria-checked=\"true\"]').dataset.v"), '15');
    // The failed account keeps its figures, dimmed, and the week it has no figure for says so.
    assert.deepEqual(await app.evaluate("const c = document.querySelector('#usage-pop .ua[data-id=\"c\"]'); return [c.classList.contains('old'), !!c.querySelector('time.old'), !!c.querySelector('.meter.none'), c.querySelector('.uw:last-of-type small').textContent];"),
      [true, true, true, 'no figure yet']);
    // Only by hand: saved, and no next round.
    await app.click('#usage-pop [data-segc="usage-every"][data-v="0"]');
    await app.until("const s = await window.ide.call('state'); return s.settings.usageRefreshMins === 0 && s.usageClock.nextAt === null;", 'only by hand');
    // A refresh by hand runs a round.
    const before = await app.evaluate("return (await window.ide.call('state')).usageClock.checkedAt;");
    await app.evaluate("await new Promise((r) => setTimeout(r, 20)); document.querySelector('#usage-pop .ubtn').click(); return 1;");
    await app.until(`return (await window.ide.call('state')).usageClock.checkedAt !== ${JSON.stringify(before)};`, 'a new round');
    // The popover's buttons are reached with the keyboard from the rings, and Escape brings the focus back.
    await app.evaluate("document.querySelector('#usage').focus(); document.querySelector('#usage').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); return 1;");
    assert.equal(await app.evaluate("document.activeElement?.closest('#usage-pop') ? 'in' : 'out'"), 'in');
  });
}

flow('the tooltip shows a control\'s name and shortcut on hover and on keyboard focus, and cut text in full', {}, async (app) => {
  await app.evaluate("window.__tip = () => { const el = document.querySelector('#tip'); if (el.hidden || !el.classList.contains('on')) return null; const r = el.getBoundingClientRect(); return { text: el.querySelector('span').textContent, key: el.querySelector('kbd')?.textContent ?? '', top: r.top, bottom: r.bottom, left: r.left, right: r.right }; }; return 1;");
  const tip = () => app.evaluate('return window.__tip();');
  const box = (sel) => app.evaluate(`const r = document.querySelector('${sel}').getBoundingClientRect(); return { top: r.top, bottom: r.bottom };`);
  const mod = process.platform === 'darwin' ? '⌘' : 'Ctrl+';
  // A corner of the window with no control and no text under it: the middle of the thread can hold a cut title.
  const AWAY = { x: 3, y: 3 };
  assert.ok(!(await tip()));
  // Hover: after the delay, above the control, with the shortcut as a key and not in the sentence.
  await app.hover('#side-toggle');
  await app.until('!!window.__tip()', 'the tooltip on hover');
  const shown = await tip();
  assert.equal(shown.text, 'Collapse the sidebar');
  assert.equal(shown.key, `${mod}B`);
  assert.ok(shown.bottom < (await box('#side-toggle')).top, 'above the control');
  // The name is already the button's label: the tooltip does not describe it again.
  assert.equal(await app.evaluate("return document.querySelector('#side-toggle').getAttribute('aria-describedby') ?? '';"), '');
  assert.equal(await app.evaluate("return document.querySelector('#side-toggle').getAttribute('aria-keyshortcuts');"), process.platform === 'darwin' ? 'Meta+B' : 'Control+B');
  // A key takes it away.
  await app.key('Escape', 'Escape', 27);
  await app.until('!window.__tip()', 'the tooltip gone after a key');
  // Keyboard focus shows it at once; in the toolbar it sits below.
  await app.hover(AWAY);
  await app.evaluate("document.querySelector('#cmdk-btn').focus({ focusVisible: true }); return 1;");
  await app.until("window.__tip()?.text === 'Search and go'", 'the tooltip on focus');
  const below = await tip();
  assert.equal(below.key, `${mod}K`);
  assert.ok(below.top > (await box('#cmdk-btn')).bottom, 'below a toolbar control');
  await app.evaluate("document.querySelector('#chat-input').focus(); return 1;");
  await app.until('!window.__tip()', 'the tooltip gone on blur');
  // Cut text: a long title in the sidebar shows in full; a short one has nothing to add.
  const long = 'A task with a title that is far too long to fit in one line of the sidebar row';
  await app.say(`@fake task - ${long}\n@@fake result Done.\n@fake task - Short\n@@fake result Done.`);
  await app.until("!!document.querySelector('#side [data-action=\"done-toggle\"]') && document.querySelectorAll('#chat-ins .res').length >= 2", 'both tasks done');
  await app.click('#side [data-action="done-toggle"]');
  await app.until("[...document.querySelectorAll('#side .row .t b')].filter((x) => x.textContent.includes('far too long') || x.textContent.trim() === 'Short').length >= 2", 'two rows in the sidebar');
  await app.evaluate("const all = [...document.querySelectorAll('#side .row .t b')]; all.find((x) => x.textContent.includes('far too long')).id = 'e2e-long'; all.find((x) => x.textContent.trim() === 'Short').id = 'e2e-short'; return 1;");
  await app.hover('#e2e-long');
  await app.until('!!window.__tip()', 'the tooltip on cut text');
  const cut = await tip();
  assert.match(cut.text, /far too long to fit in one line of the sidebar row/);
  assert.ok(cut.left >= 8 && cut.right <= (await app.evaluate('window.innerWidth')) - 8, 'inside the window');
  await app.hover(AWAY);
  await app.until('!window.__tip()', 'the tooltip gone when the pointer leaves');
  await app.hover('#e2e-short');
  await new Promise((r) => setTimeout(r, 900));
  assert.ok(!(await tip()), 'no tooltip for text that fits');
});

flow('a state update that changes nothing in a panel leaves the panel as it is', {}, async (app) => {
  await app.say('@fake task - Something to list\n@@fake result Done.');
  await app.until("!!document.querySelector('#chat-ins .res')", 'the result card');
  // Mark the elements now on screen. A redraw would replace them with new ones without the mark.
  const mark = "for (const id of ['side', 'chat-ins']) document.getElementById(id).firstElementChild.dataset.kept = '1'; return 1;";
  const kept = "['side', 'chat-ins'].map((id) => document.getElementById(id).firstElementChild?.dataset.kept === '1')";
  await app.evaluate(mark);
  // A state update with nothing new for these panels: the launch checks are run again, which pushes the state.
  await app.evaluate("await window.ide.call('preflight:run'); await new Promise((r) => setTimeout(r, 500)); return 1;");
  assert.deepEqual(await app.evaluate(kept), [true, true]);
  // Something new for both: they are drawn again.
  await app.say('@fake task - One more\n@@fake result Done too.');
  await app.until("document.querySelectorAll('#chat-ins .res').length === 2", 'the second result card');
  assert.deepEqual(await app.evaluate(kept), [false, false]);
  // After the user does something, the next draw is a real one even with the same HTML.
  await app.evaluate(mark);
  await app.evaluate("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true })); await window.ide.call('preflight:run'); await new Promise((r) => setTimeout(r, 500)); return 1;");
  assert.deepEqual(await app.evaluate(kept), [false, false]);
});

flow('a Korean syllable being composed in a sidebar field is not split when the sidebar is drawn again', {}, async (app) => {
  await app.click('#chat-ins [data-action="ins-tab"][data-v="memo"]');
  await app.until("!!document.getElementById('memo-new')", 'the new memo field');
  await app.evaluate("const i = document.getElementById('memo-new'); window.__field = i; window.__ends = 0; i.addEventListener('compositionend', () => window.__ends++); i.focus(); return 1;");
  // A key first, so the draws that follow are real ones (skipSameHtml lets them through after user input).
  await app.key('ShiftLeft', 'Shift', 16);
  await app.cdp('Input.imeSetComposition', { text: 'ㅎ', selectionStart: 1, selectionEnd: 1 });
  await app.cdp('Input.imeSetComposition', { text: '하', selectionStart: 1, selectionEnd: 1 });
  // The sidebar has something new to draw while the syllable is half built.
  await app.say('@fake task - Something to list\n@@fake result Done.');
  await app.until("return (await window.ide.call('state')).results.length > 0", 'the result');
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(await app.evaluate('window.__ends'), 0, 'the composition went on');
  assert.equal(await app.evaluate("document.getElementById('memo-new') === window.__field"), true, 'the field was not replaced mid-syllable');
  await app.cdp('Input.imeSetComposition', { text: '한', selectionStart: 1, selectionEnd: 1 });
  await app.cdp('Input.insertText', { text: '한' });
  assert.equal(await app.evaluate("document.getElementById('memo-new').value"), '한');
  // The draw that waited for the syllable happens once it is done, and the text stays.
  await app.until("document.getElementById('memo-new') !== window.__field", 'the held draw');
  assert.equal(await app.evaluate("document.getElementById('memo-new').value"), '한');
  assert.equal(await app.evaluate("document.activeElement?.id"), 'memo-new');
});

flow('the sidebar tab pill follows the sidebar width while it changes', {}, async (app) => {
  await app.click('#chat-ins [data-action="ins-tab"][data-v="auto"]');
  await app.until("document.querySelector('#chat-ins .ins-tabs button[aria-selected=\"true\"]')?.dataset.v === 'auto'", 'the Automations tab');
  // The pill (the control's ::before, placed by --gx/--gw) against the chosen tab, and how many rows the tabs take.
  const where = `const c = document.querySelector('#chat-ins .ins-tabs'); const on = c.querySelector('button[aria-selected="true"]');
    return [parseFloat(c.style.getPropertyValue('--gx')) - on.offsetLeft, parseFloat(c.style.getPropertyValue('--gw')) - on.offsetWidth, new Set([...c.children].map((b) => b.offsetTop)).size];`;
  const frames = 'for (let i = 0; i < 4; i++) await new Promise((r) => requestAnimationFrame(r)); return 1;';
  // A drag marks the window once as it starts...
  await app.evaluate(`document.getElementById('win').classList.add('rz-still'); ${frames}`);
  assert.deepEqual(await app.evaluate(where), [0, 0, 1]);
  // ...then only the width changes: no class, no new element, no window resize.
  for (const w of [640, 320]) {
    await app.evaluate(`document.getElementById('win').style.setProperty('--inspector-w', '${w}px'); ${frames}`);
    assert.deepEqual(await app.evaluate(where), [0, 0, 1], `at ${w}px`);
  }
});

flow('what is typed for one Worker waits for that Worker while another one is open', {}, async (app) => {
  await app.say('@fake task - First\n@@fake result Done.\n@fake task - Second\n@@fake result Done.');
  await app.until("document.querySelectorAll('#chat-ins .res').length >= 2", 'both tasks done');
  await app.click('#side [data-action="done-toggle"]');
  await app.until("document.querySelectorAll('#side [data-action=\"open-worker\"]').length >= 2", 'both Workers in the sidebar');
  const [a, b] = (await app.state()).workers.map((w) => w.id);
  const open = async (id) => {
    await app.click(`#side [data-action="open-worker"][data-id="${id}"]`);
    await app.until(`!!document.querySelector('#ws-form').offsetParent && document.querySelector('#ws-title').textContent.startsWith('${id} ')`, `the conversation of ${id}`);
  };
  const typed = () => app.evaluate("document.querySelector('#ws-input').value");
  const type = (v) => app.evaluate(`const i = document.querySelector('#ws-input'); i.focus(); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('input', { bubbles: true })); return 1;`);
  await open(a);
  await type('Only for the first Worker\nand its second line');
  const tall = await app.evaluate("document.querySelector('#ws-input').offsetHeight");
  // The other Worker starts with an empty box, one line high.
  await open(b);
  assert.equal(await typed(), '');
  assert.ok((await app.evaluate("document.querySelector('#ws-input').offsetHeight")) < tall, 'the box is back to one line');
  await type('For the second');
  // Back at the first: its text, and the box as tall as the text.
  await open(a);
  assert.equal(await typed(), 'Only for the first Worker\nand its second line');
  assert.equal(await app.evaluate("document.querySelector('#ws-input').offsetHeight"), tall);
  // Another view in between changes nothing.
  await app.click('button[data-v="chat"]');
  await open(b);
  assert.equal(await typed(), 'For the second');
  // Sent, it goes to the Worker it was written for and leaves the box; the other draft still waits.
  await app.evaluate("document.querySelector('#ws-form').requestSubmit(); return 1;");
  await app.until("document.querySelector('#ws-thread').innerText.includes('For the second') && document.querySelector('#ws-input').value === ''", 'the message sent to the second Worker');
  await open(a);
  assert.equal(await typed(), 'Only for the first Worker\nand its second line');
  assert.equal(await app.evaluate("document.querySelector('#ws-thread').innerText.includes('For the second')"), false);
  await open(b);
  assert.equal(await typed(), '');
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
  await app.evaluate("document.querySelector('#ins-toggle').focus()");
  await tab();
  assert.equal(await app.evaluate("document.activeElement?.dataset.action"), 'chat-start');
  for (let i = 1; i <= 6; i++) {
    await app.say(`Question ${i}\n@fake say Answer ${i} with https://example.com/${i}.`);
    await app.until(`document.querySelector('#chat-thread').innerText.includes('Answer ${i} with')`, `answer ${i}`);
  }
  // From the toolbar, the thread is one stop (its last message), however many links and reply buttons it holds.
  await app.evaluate("document.querySelector('#ins-toggle').focus()");
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

flow('step rows grow with the text, link rows take a click 24px high, and a narrow card gives its title a line', { repos: ['billing'], settings: { fontSize: 20 } }, async (app) => {
  await app.size(1200, 760);
  await app.say(['Hello', '@fake task - First task with a rather long title that goes on', '@@fake steps Read the code | Write the change | Run the tests | Open the PR', '@@fake step 2',
    '@@fake permission Bash: npm test', '@fake task - Second', '@@fake result Done.'].join('\n'));
  await app.until("document.querySelectorAll('#chat-ins .dec').length === 1 && !!document.querySelector('#side .stp .s') && !!document.querySelector('#chat-thread .links a')", 'a decision, a step list and a result');
  // The largest text: a step's row is as high as its text, and the list is as high as its rows.
  const steps = JSON.parse(await app.evaluate(`const stp = document.querySelector('#side .stp');
    return JSON.stringify({ n: Number(getComputedStyle(stp).getPropertyValue('--n')), box: stp.getBoundingClientRect().height,
      rows: [...stp.querySelectorAll('.s')].map((s) => [s.getBoundingClientRect().height, s.querySelector('em').getBoundingClientRect().height]) });`));
  assert.ok(steps.rows.length >= 2);
  for (const [row, text] of steps.rows) assert.ok(row >= text - 0.5 && row > 20, `a row of ${row}px for a text of ${text}px`);
  assert.ok(Math.abs(steps.box - steps.n * steps.rows[0][0]) < 1, 'the list is as high as the rows it shows');
  const more = JSON.parse(await app.evaluate("const m = document.querySelector('#side .stp-more'); return JSON.stringify(m ? [m.getBoundingClientRect().height, parseFloat(getComputedStyle(m).fontSize)] : null);"));
  if (more) assert.ok(more[0] >= more[1] * 1.2, 'the "more" line holds its text');
  // The placeholders are short and stay on one line.
  assert.equal(await app.evaluate("document.querySelector('#chat-input').placeholder"), 'Ask the Dispatcher');
  assert.equal(await app.evaluate("getComputedStyle(document.querySelector('#chat-input'), '::placeholder').whiteSpace"), 'nowrap');
  assert.equal(await app.evaluate("getComputedStyle(document.querySelector('#chat-ins .dec input.inp')).textOverflow"), 'ellipsis');
  // At the usual size a link row is one text line high, and the click is taken 11px above and below its middle.
  await app.evaluate("document.documentElement.style.setProperty('--ui-font-size', '13px'); return 1;");
  const hits = await app.evaluate(`const out = [];
    for (const el of document.querySelectorAll('#chat-thread .links a, #chat-thread .linkbtn')) {
      const r = el.getBoundingClientRect();
      if (!r.width) continue;
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const hit = (y) => { const t = document.elementFromPoint(cx, y); return !!t && (t === el || el.contains(t)); };
      out.push((el.dataset.action || 'link') + ' ' + Math.round(r.height) + ' ' + (hit(cy - 11) && hit(cy + 11)));
    }
    return out.join(', ');`);
  assert.ok(hits.length > 0 && !hits.includes('false'), hits);
  assert.match(hits, / 1[0-9] true/, 'a link row lower than 24px was measured');
  // The source line of a decision card: in the narrow right sidebar the title has the line under the kind and the age.
  const src = "const s = document.querySelector('#chat-ins .dec .src'); const top = (q) => s.querySelector(q).getBoundingClientRect().top; return JSON.stringify([top('.who') - top('.dkind'), s.querySelector('.who').getBoundingClientRect().width, s.getBoundingClientRect().width]);";
  let [down, who, line] = JSON.parse(await app.evaluate(src));
  assert.ok(down > 10 && who > line * 0.9, `the title has its own line (${down}, ${who} of ${line})`);
  // A wide one keeps them on one line.
  await app.size(1500, 760);
  await app.evaluate("document.querySelector('#rz-ins').focus(); return 1;");
  for (let i = 0; i < 30; i++) await app.key('ArrowLeft', 'ArrowLeft', 37);
  await app.until("document.querySelector('#chat-ins .dec .src').getBoundingClientRect().width > 400", 'a wide right sidebar');
  [down, who, line] = JSON.parse(await app.evaluate(src));
  assert.ok(Math.abs(down) < 8 && who < line * 0.9, `one line when there is room (${down}, ${who} of ${line})`);
});

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
  // The default sidebar is one column: the list is one Tab stop, nothing is selected, and its header says "Clear all".
  assert.equal(await app.evaluate("return !!document.querySelector('#chat-ins .ins-cols.split');"), false);
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
