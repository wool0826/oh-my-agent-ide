// End-to-end flows: Decisions a Worker waits on: permissions, questions, plans, their keys and allowances.
// Each flow starts the built app on its own empty profile with fake agents and a stand-in for gh. Run with `npm run e2e`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { flow } from './harness.mjs';

const task = (state, title) => state.tasks.find((x) => x.title === title);
/** What IDE memory keeps of the answered decisions, all months together. */
const remembered = (app) => {
  const dir = path.join(app.home, 'memory', 'decisions');
  return fs.existsSync(dir) ? fs.readdirSync(dir).map((n) => fs.readFileSync(path.join(dir, n), 'utf8')).join('\n') : '';
};
const DEC = '#chat-ins .dec';
const answer = (val) => `${DEC} [data-action="answer"][data-val="${val}"]`;

flow('a permission is asked once, allowed for the task, and the result card has the file', {}, async (app) => {
  await app.say(['Write a note', '@fake task - Write a note', '@@fake permission npm install left-pad', '@@fake permission npm install is-odd',
    '@@fake write out/note.md hello', '@@fake file out/note.md', '@@fake result Wrote the note.'].join('\n'));
  await app.until(`!!document.querySelector('${DEC}')`, 'the permission card');
  assert.match(await app.evaluate(`document.querySelector('${DEC}').innerText`), /npm install left-pad/);
  // Plain words and risk badges above the command; the scope row says what "Allow for this task" covers. Nothing says
  // what this install is for (no plan step, no words before it): no reason row, and no gap for one.
  const card = await app.evaluate(`const c = document.querySelector('${DEC}'); return { rows: [...c.querySelectorAll('.kv dt')].map((x) => x.textContent), what: c.querySelector('.kv dd.w').textContent, risk: [...c.querySelectorAll('.risks .pill')].map((x) => x.textContent), scope: c.querySelector('.kv dd > code')?.textContent };`);
  assert.deepEqual(card, { rows: ['Action', 'Risk', 'Scope'], what: 'Install dependencies', risk: ['Network', 'Changes files'], scope: 'npm install' });
  // The slot clock shows from the start.
  await app.until(`!document.querySelector('${DEC} .dhold').hidden`, 'the slot clock', 5000);
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
  // The task keeps the permission for the look back; memory keeps nothing of it.
  assert.equal(t.permissions.length > 0, true);
  assert.doesNotMatch(remembered(app), /Run this command|Allow for this task/);
});

flow('an always-ask rule offers no "Allow for this task", and a denial reaches the Worker', {}, async (app) => {
  await app.say('@fake task - Push it\n@@fake steps Rebase on main | Push the branch\n@@fake step 1\n@@fake say Pushing the rebased branch so the PR shows the fix.\n@@fake permission git push --force origin feature\n@@fake result Left the branch alone.');
  await app.until(`!!document.querySelector('${DEC}')`, 'the permission card');
  assert.equal(await app.evaluate(`!!document.querySelector('${answer('allow-task')}')`), false);
  assert.match(await app.evaluate(`document.querySelector('${DEC}').innerText`), /force push/i);
  // Why the push is needed: the current plan step in one line, with the step and the Worker's words in its tooltip. The
  // always-ask rule is the first risk badge, the scope is asked each time, and allowing once is the red button.
  const purpose = { text: 'Needed for step 2 of 2 of this task, “Push the branch”. Pushing the rebased branch so the PR shows the fix.' };
  const look = await app.evaluate(`const c = document.querySelector('${DEC}'); const dd = [...c.querySelectorAll('.kv dt')].find((x) => x.textContent === 'Reason').nextElementSibling; return { why: dd.textContent, tip: dd.dataset.tip, risk: c.querySelector('.risks .pill').textContent, scope: c.querySelector('.kv dd:last-of-type').textContent, allow: c.querySelector('[data-val="allow"]').className };`);
  assert.deepEqual(look, { why: 'Step 2/2 · Push the branch', tip: purpose.text, risk: 'force push', scope: 'Ask each time', allow: 'btn btn-danger' });
  // The Worker's conversation names the command on the line above its composer, and Deny there answers.
  const wid = (await app.state()).workers[0].id;
  await app.click(`#side [data-action="open-worker"][data-id="${wid}"]`);
  await app.until("!!document.querySelector('#ws-dec:not([hidden]) code')", 'the decision line with the command');
  assert.equal(await app.evaluate("document.querySelector('#ws-dec code').textContent"), '$ git push --force origin feature');
  assert.equal(await app.evaluate("document.querySelector('#ws-dec .cs-why').textContent"), purpose.text);
  await app.click('#ws-dec [data-val="deny"]');
  await app.until("window.ide.call('state').then((s) => s.tasks.some((t) => t.status === 'done'))", 'the task done');
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
  assert.match(remembered(app), /Split the PR in two\? → Split/, 'a real question and its answer are remembered');
});

flow('permission answers and repeats saved in memory before are taken out at launch, with the file kept in data/backups', {
  files: {
    'memory/decisions/2026-11.md': [
      '# Decisions 2026-11', '',
      '- W-06: Run this command? → Allow _(2026-11-24)_',
      '- W-12: Allow recall? → Allow _(2026-11-24)_',
      '- W-20: Review the plan → Approve plan _(2026-11-25)_',
      '- Dispatcher: Push the v0.7.0 tag? → hold: test it first _(2026-11-25)_',
      '- Dispatcher: Push the v0.7.0 tag? → hold: test it first _(2026-11-26)_', '',
    ].join('\n'),
  },
}, async (app) => {
  await app.state();
  assert.equal(remembered(app), '# Decisions 2026-11\n\n- Dispatcher: Push the v0.7.0 tag? → hold: test it first _(2026-11-25)_\n');
  const copies = fs.readdirSync(path.join(app.home, 'data', 'backups')).filter((n) => n.startsWith('memory-decisions-2026-11-'));
  assert.equal(copies.length, 1);
  assert.match(fs.readFileSync(path.join(app.home, 'data', 'backups', copies[0]), 'utf8'), /Run this command\?/);
  // Recall finds the real decision and none of what was taken out.
  const hits = await app.evaluate("return await window.ide.call('memory:search', 'Run this command tag');");
  const texts = (hits.hits ?? hits).map((h) => h.text).join('\n');
  assert.match(texts, /v0\.7\.0 tag/);
  assert.doesNotMatch(texts, /Run this command/);
});

flow('decision cards take the keys: none is selected at first, Enter or ↓ selects, Enter allows, the next card gets the focus and a number picks', {}, async (app) => {
  await app.say('@fake task - Install one\n@@fake permission npm install a\n@@fake result Installed.\n@fake task - Pick one\n@@fake ask Which side? | Left | Right\n@@fake result Picked.');
  const CARD = `${DEC}[data-dec]`;
  await app.until(`document.querySelectorAll('${CARD}').length === 2`, 'both decision cards');
  // Nothing is selected and no card shows key hints; the first card is the list's one Tab stop.
  // kbd: a key hint shows (they keep their room and only fade in). btns: each button's value and box within its card.
  const look = () => app.evaluate(`document.getAnimations().forEach((a) => a.finish()); const c = [...document.querySelectorAll('${CARD}')]; return c.map((x) => { const r = x.getBoundingClientRect(); return { sel: x.getAttribute('aria-current') === 'true', tab: x.tabIndex, focus: document.activeElement === x, perm: !!x.querySelector('[data-val="deny"]'), kbd: [...x.querySelectorAll('kbd')].some((k) => getComputedStyle(k).opacity !== '0'), outline: getComputedStyle(x).outlineStyle, btns: [...x.querySelectorAll('.btns .btn')].map((b) => { const q = b.getBoundingClientRect(); return [b.dataset.val, Math.round(q.left - r.left), Math.round(q.top - r.top), Math.round(q.width)].join(' '); }) }; });`);
  let cards = await look();
  assert.deepEqual(cards.map((c) => [c.sel, c.tab, c.kbd]), [[false, 0, false], [false, -1, false]]);
  // The focus alone selects nothing, and Enter on a card that is not selected selects it instead of answering.
  await app.key('Shift', 'Shift', 16); // a key first, so the focus below is a keyboard one (:focus-visible)
  await app.evaluate(`document.querySelector('${CARD}').focus(); return 1;`);
  cards = await look();
  assert.deepEqual(cards.map((c) => [c.sel, c.focus]), [[false, true], [false, false]]);
  const before = cards;
  await app.key('Enter', 'Enter', 13);
  cards = await look();
  assert.deepEqual(cards.map((c) => [c.sel, c.tab, c.kbd]), [[true, 0, true], [false, -1, false]]);
  // Selecting moves and reorders no button; the focus alone is a dashed outline, focus and selection a solid one.
  assert.deepEqual(cards.map((c) => c.btns), before.map((c) => c.btns));
  assert.equal(before[0].outline, 'dashed');
  assert.equal(cards[0].outline, 'solid');
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

flow('the Next button and Ctrl/Cmd+I go round the waiting decisions; the count is on Next and the taskbar only', {}, async (app) => {
  const mod = process.platform === 'darwin' ? 4 : 2;
  await app.say('@fake task - Install one\n@@fake permission npm install a\n@@fake result Installed.\n@fake task - Pick one\n@@fake ask Which side? | Left | Right\n@@fake result Picked.');
  const CARD = `${DEC}[data-dec]`;
  await app.until(`document.querySelectorAll('${CARD}').length === 2`, 'both decision cards');
  const ids = await app.evaluate(`return [...document.querySelectorAll('${CARD}')].map((c) => c.dataset.dec);`);
  const at = () => app.evaluate(`const c = document.querySelector('${CARD}[aria-current="true"]'); return c && document.activeElement === c ? c.dataset.dec : null;`);
  const go = async (want, what) => app.until(`const c = document.querySelector('${CARD}[aria-current="true"]'); return !!c && c.dataset.dec === ${JSON.stringify(want)} && document.activeElement === c;`, what);
  // The strip's Next button counts them; the right sidebar's button is its icon alone.
  assert.deepEqual(JSON.parse(await app.evaluate("const b = document.querySelector('#next-btn'); return JSON.stringify([b.hidden, b.innerText.trim(), document.querySelector('#ins-toggle').innerText.trim(), b.getAttribute('aria-label')]);")),
    [false, '2', '', 'Next waiting item 2']);
  await app.until("return (async () => (await window.ide.call('e2e:badge')).n === 2)();", 'the taskbar badge at 2');
  if (process.platform === 'win32') assert.equal((await app.evaluate("return await window.ide.call('e2e:badge');")).overlay, true);
  // Nothing is selected: Next goes to the first, then on and round; Shift goes back.
  await app.click('#next-btn');
  await go(ids[0], 'Next: the first card');
  await app.key('KeyI', 'i', 73, mod);
  await go(ids[1], 'Ctrl+I: the second card');
  await app.key('KeyI', 'i', 73, mod);
  await go(ids[0], 'Ctrl+I: round to the first');
  await app.key('KeyI', 'I', 73, mod | 8);
  await go(ids[1], 'Ctrl+Shift+I: back to the second');
  assert.equal(await at(), ids[1]);
  // The palette lists both commands with their keys.
  await app.key('KeyK', 'k', 75, mod);
  await app.until("document.querySelector('#cmdk-q') === document.activeElement", 'the palette');
  await app.evaluate("const q = document.querySelector('#cmdk-q'); q.value = 'waiting'; q.dispatchEvent(new Event('input', { bubbles: true })); return 1;");
  await app.until("[...document.querySelectorAll('#cmdk-list .cmdk-it')].map((x) => x.innerText).join('|').includes('Previous waiting item')", 'both commands in the palette');
  await app.key('Escape', 'Escape', 27);
  // With every decision answered, Next is gone, the badge clears and Ctrl+I says nothing waits.
  for (const id of await app.evaluate(`return [...document.querySelectorAll('${CARD}')].map((c) => c.dataset.dec);`)) {
    await app.evaluate(`await window.ide.call('decision:answer', ${JSON.stringify(id)}, document.querySelector('[data-dec="' + ${JSON.stringify(id)} + '"] [data-val="deny"]') ? 'deny' : 'Left'); return 1;`);
  }
  await app.until(`document.querySelectorAll('${CARD}').length === 0 && document.querySelector('#next-btn').hidden`, 'Next hidden with nothing waiting');
  await app.until("return (async () => (await window.ide.call('e2e:badge')).n === 0)();", 'the taskbar badge cleared');
  await app.key('KeyI', 'i', 73, mod);
  await app.until("[...document.querySelectorAll('#toasts .toast')].some((x) => x.innerText.includes('Nothing waiting') && x.querySelector('.ic'))", 'the nothing-waiting toast');
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

flow('a plan card reads what, why, risk and result in one line each, with its long text behind Details and the text field behind its button', {}, async (app) => {
  const long = 'Remove the inner list and detail split from the right panel so that every tab is one column at any width';
  await app.say(`@fake task - Plan the panel\n@@fake plan WHAT: ${long}\\nHOW: drop the split mode\\nRISK: visual baselines change\\nOUTPUT: one merged PR\\n\\n## Details\\nMore text.\n@@fake result Done.`);
  const CARD = `${DEC}.brief`;
  await app.until(`!!document.querySelector('${CARD}')`, 'the plan card');
  const look = () => app.evaluate(`const c = document.querySelector('${CARD}'); const rows = [...c.querySelectorAll('.kvt tr')]; const inp = c.querySelector('input.inp'); return {
    title: c.querySelector('.q').textContent,
    rows: rows.map((r) => [r.querySelector('th').textContent, r.querySelector('td').textContent]),
    tip: rows[0].querySelector('td').dataset.tip,
    oneLine: rows.every((r) => { const td = r.querySelector('td'); return getComputedStyle(td).whiteSpace === 'nowrap' && td.scrollHeight < 2 * parseFloat(getComputedStyle(td).fontSize) * 1.6; }),
    fits: c.scrollWidth <= c.clientWidth,
    more: c.querySelector('.more').hidden, moreText: c.querySelector('.more').textContent,
    open: c.querySelector('[data-fold="more"]').getAttribute('aria-expanded'),
    inp: inp.hidden, focus: document.activeElement === inp, cut: getComputedStyle(inp).textOverflow,
    btns: getComputedStyle(c.querySelector('.btns')).flexDirection,
  };`);
  let c = await look();
  assert.match(c.title, /^Approve the T-\d+ plan$/);
  assert.deepEqual(c.rows.map((r) => r[0]), ['What', 'Why', 'Risk', 'Result']);
  assert.ok(c.rows[0][1].length <= 60 && c.rows[0][1].endsWith('…') && long.startsWith(c.rows[0][1].slice(0, -1).trimEnd()), c.rows[0][1]);
  assert.deepEqual(c.rows.slice(1), [['Why', 'Plan-first · nothing changes before approval'], ['Risk', 'visual baselines change'], ['Result', 'one merged PR']]);
  assert.equal(c.tip, long);
  assert.deepEqual([c.oneLine, c.fits, c.more, c.open, c.inp, c.btns, c.cut], [true, true, true, 'false', true, 'column', 'ellipsis']);
  // Details opens the plan's own lines in place; the reply button opens the text field and gives it the focus.
  await app.click(`${CARD} [data-fold="more"]`);
  await app.click(`${CARD} [data-fold="reply"]`);
  c = await look();
  assert.deepEqual([c.more, c.open, c.inp, c.focus], [false, 'true', false, true]);
  assert.match(c.moreText, /drop the split mode/);
  await app.cdp('Input.insertText', { text: 'Make it two PRs' });
  await app.key('Enter', 'Enter', 13);
  await app.until("!!document.querySelector('#chat-ins .res')", 'the result card');
  assert.match(await app.workerLog(task(await app.state(), 'Plan the panel').workerId), /Plan sent back: .*Make it two PRs/);
});

flow('a PowerShell delete without a description says what it does, is red, has no "Allow for this task", and folds its command', {}, async (app) => {
  await app.say('@fake task - Clean the build\n@@fake pspermission Remove-Item -Recurse -Force .\\dist, .\\node_modules\\.cache\n@@fake result Cleaned.');
  await app.until(`!!document.querySelector('${DEC}.perm')`, 'the permission card');
  const look = () => app.evaluate(`const c = document.querySelector('${DEC}.perm'); const code = c.querySelector('.cmd > code'); return {
    kind: c.querySelector('.dkind').textContent, what: c.querySelector('.kv dd.w').textContent,
    risk: [...c.querySelectorAll('.risks .pill')].map((x) => [x.textContent, x.dataset.tone]),
    scope: c.querySelector('.kv dd:last-of-type').textContent,
    btns: [...c.querySelectorAll('.btns .btn')].map((b) => b.dataset.val + ' ' + b.className),
    folded: getComputedStyle(code).whiteSpace === 'nowrap', fits: c.scrollWidth <= c.clientWidth,
    open: c.querySelector('[data-fold="cmd"]').getAttribute('aria-expanded'),
  };`);
  let c = await look();
  assert.deepEqual(c, {
    kind: 'Command', what: 'Delete dist · node_modules/.cache', risk: [['Deletes', 'danger']], scope: 'Ask each time',
    btns: ['deny btn', 'allow btn btn-danger'], folded: true, fits: true, open: 'false',
  });
  await app.click(`${DEC}.perm [data-fold="cmd"]`);
  c = await look();
  assert.deepEqual([c.folded, c.open], [false, 'true']);
  // The answer reaches the Worker: denied, the command does not run.
  await app.click(answer('deny'));
  await app.until("!!document.querySelector('#chat-ins .res')", 'the result card');
  assert.match(await app.workerLog(task(await app.state(), 'Clean the build').workerId), /Not allowed: Remove-Item/);
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
