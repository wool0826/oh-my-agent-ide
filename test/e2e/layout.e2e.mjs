// End-to-end flows: The sidebar, memos and redraws: what stays in place, keeps its text and fits the width.
// Each flow starts the built app on its own empty profile with fake agents and a stand-in for gh. Run with `npm run e2e`.
import assert from 'node:assert/strict';
import { flow } from './harness.mjs';

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
  // The field is the one the composition starts in: a draw before that may still replace the field first focused.
  await app.evaluate("window.__field = null; window.__ends = 0; document.addEventListener('compositionstart', (e) => { window.__field = e.target; }, true); document.addEventListener('compositionend', () => window.__ends++, true); document.getElementById('memo-new').focus(); return 1;");
  // A key first, so the draws that follow are real ones (skipSameHtml lets them through after user input).
  await app.key('ShiftLeft', 'Shift', 16);
  await app.cdp('Input.imeSetComposition', { text: 'ㅎ', selectionStart: 1, selectionEnd: 1 });
  await app.cdp('Input.imeSetComposition', { text: '하', selectionStart: 1, selectionEnd: 1 });
  await app.until("window.__field?.id === 'memo-new' && window.__field.isConnected", 'the syllable being composed in the new memo field', 20_000, "'in: ' + (window.__field?.outerHTML.slice(0, 120) ?? 'nothing') + ', focus: ' + document.activeElement?.id");
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
