// End-to-end flows: Decisions a Worker waits on: permissions, questions, plans, their keys and allowances.
// Each flow starts the built app on its own empty profile with fake agents and a stand-in for gh. Run with `npm run e2e`.
import assert from 'node:assert/strict';
import { flow } from './harness.mjs';

const task = (state, title) => state.tasks.find((x) => x.title === title);
const DEC = '#chat-ins .dec';
const answer = (val) => `${DEC} [data-action="answer"][data-val="${val}"]`;

flow('a permission is asked once, allowed for the task, and the result card has the file', {}, async (app) => {
  await app.say(['Write a note', '@fake task - Write a note', '@@fake permission npm install left-pad', '@@fake permission npm install is-odd',
    '@@fake write out/note.md hello', '@@fake file out/note.md', '@@fake result Wrote the note.'].join('\n'));
  await app.until(`!!document.querySelector('${DEC}')`, 'the permission card');
  assert.match(await app.evaluate(`document.querySelector('${DEC}').innerText`), /npm install left-pad/);
  // What "Allow for this task" covers is the line just above the buttons, and the slot clock shows from the start.
  const scope = await app.evaluate(`const sc = document.querySelector('${DEC} .scope'); return { next: sc?.nextElementSibling?.matches('.btns.perm'), text: sc?.textContent };`);
  assert.equal(scope.next, true);
  assert.match(scope.text, /npm install/);
  // Nothing says what this install is for (no plan step, no words before it): no purpose line, and no gap for one.
  assert.equal(await app.evaluate(`!!document.querySelector('${DEC} .purpose')`), false);
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
});

flow('an always-ask rule offers no "Allow for this task", and a denial reaches the Worker', {}, async (app) => {
  await app.say('@fake task - Push it\n@@fake steps Rebase on main | Push the branch\n@@fake step 1\n@@fake say Pushing the rebased branch so the PR shows the fix.\n@@fake permission git push --force origin feature\n@@fake result Left the branch alone.');
  await app.until(`!!document.querySelector('${DEC}')`, 'the permission card');
  assert.equal(await app.evaluate(`!!document.querySelector('${answer('allow-task')}')`), false);
  assert.match(await app.evaluate(`document.querySelector('${DEC}').innerText`), /force push/i);
  // What the push is for: the current plan step and the Worker's words just before it asked, just above the command.
  const purpose = await app.evaluate(`const p = document.querySelector('${DEC} .purpose'); return { text: p?.textContent, next: p?.nextElementSibling?.tagName };`);
  assert.equal(purpose.text, 'Needed for step 2 of 2 of this task, “Push the branch”. Pushing the rebased branch so the PR shows the fix.');
  assert.equal(purpose.next, 'CODE');
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

flow('a plan waits for approval before the work goes on', {}, async (app) => {
  await app.say('@fake task - Plan the change\n@@fake plan WHAT: rename the field\\nHOW: one commit\\nOUTPUT: a PR\n@@fake result Carried out the plan.');
  await app.until(`!!document.querySelector('${DEC}')`, 'the plan card');
  assert.equal((await app.state()).decisions.find((d) => d.status === 'pending').source, 'plan');
  await app.click(answer('allow'));
  await app.until("!!document.querySelector('#chat-ins .res')", 'the result card');
  const t = task(await app.state(), 'Plan the change');
  assert.match(await app.workerLog(t.workerId), /Plan approved\./);
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
