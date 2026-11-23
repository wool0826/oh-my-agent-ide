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

flow('decision cards take the keys: ↓ moves the selection, Enter allows, the next card gets the focus and a number picks', {}, async (app) => {
  await app.say('@fake task - Install one\n@@fake permission npm install a\n@@fake result Installed.\n@fake task - Pick one\n@@fake ask Which side? | Left | Right\n@@fake result Picked.');
  const CARD = `${DEC}[data-dec]`;
  await app.until(`document.querySelectorAll('${CARD}').length === 2`, 'both decision cards');
  // One card is selected: the only Tab stop, with aria-current and its key hints; the other shows none.
  const look = () => app.evaluate(`const c = [...document.querySelectorAll('${CARD}')]; return c.map((x) => ({ sel: x.getAttribute('aria-current') === 'true', tab: x.tabIndex, focus: document.activeElement === x, perm: !!x.querySelector('[data-val="deny"]'), kbd: [...x.querySelectorAll('kbd')].some((k) => getComputedStyle(k).display !== 'none') }));`);
  let cards = await look();
  assert.deepEqual(cards.map((c) => [c.sel, c.tab, c.kbd]), [[true, 0, true], [false, -1, false]]);
  await app.evaluate(`document.querySelector('${CARD}[aria-current="true"]').focus(); return 1;`);
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

flow('from 560 wide the selected memo opens beside the list, and a draft keeps its text and caret across 560', {}, async (app) => {
  await app.evaluate("await window.ide.call('memo:add', 'Release notes go out on Thursdays'); await window.ide.call('memo:add', 'Prefer pnpm in new repositories'); return 1;");
  await app.click('[data-action="ins-tab"][data-v="memo"]');
  await app.until("document.querySelectorAll('#chat-ins .pk').length === 2", 'both memos');
  // The sidebar's width from its handle's keys: Home is 320, each Shift+← 64 wider.
  await app.size(1600);
  await app.evaluate("document.querySelector('#rz-ins').focus(); return 1;");
  const handle = async (code, vk, shift = false) => app.key(code, code, vk, shift ? 8 : 0);
  const where = () => app.evaluate(`const ta = document.querySelector('#chat-ins textarea[data-keep^="memo-"]'); return {
    split: !!document.querySelector('#chat-ins .ins-cols.split'),
    detail: document.querySelector('#chat-ins .ins-detail')?.innerText ?? '',
    rows: [...document.querySelectorAll('#chat-ins .pk > .li')].filter((r) => r.offsetParent).length,
    inDetail: !!ta?.closest('.ins-detail'), value: ta?.value, focus: !!ta && document.activeElement === ta, caret: ta?.selectionStart };`);
  // One column at 320: no rows, no detail pane.
  await handle('Home', 36);
  await app.until("!document.querySelector('#chat-ins .ins-cols.split')", 'one column');
  assert.equal((await where()).rows, 0);
  // At 576 the list is rows and the first memo, selected, is in the detail pane; a row selects another one.
  for (let i = 0; i < 4; i++) await handle('ArrowLeft', 37, true);
  await app.until("!!document.querySelector('#chat-ins .ins-cols.split')", 'two panes');
  let w = await where();
  assert.equal(w.rows, 2);
  assert.match(w.detail, /Prefer pnpm|Release notes/);
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
  await app.until("document.querySelectorAll('#chat-ins [data-dec]').length === 2 && !!document.querySelector('#chat-ins .ins-detail [data-dec]')", 'two decisions, one in the detail pane');
  const first = await app.evaluate("const c = document.querySelector('#chat-ins .ins-detail [data-dec]'); c.focus(); return c.dataset.dec;");
  await app.key('ArrowDown', 'ArrowDown', 40);
  const after = await app.evaluate("const c = document.querySelector('#chat-ins .ins-detail [data-dec]'); return { id: c?.dataset.dec, focus: document.activeElement === c, sel: document.querySelector('#chat-ins .pk.sel')?.dataset.pick };");
  assert.notEqual(after.id, first);
  assert.deepEqual([after.focus, after.sel], [true, after.id]);
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
  assert.match(await app.evaluate("document.querySelector('#chat-thread .attach.fail').innerText"), /stopped at step 2 of 3 · The build is broken/);
  await app.click('button[data-v="worker"]');
  const row = await app.evaluate("document.querySelector('#wk-list .wrow').innerText");
  assert.match(row, /Failed/);
  assert.match(row, /stopped at step 2 of 3 · The build is broken/);
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

flow('a code task opens a PR, which is merged from the app', { repos: ['demo'] }, async (app) => {
  const url = 'https://github.com/o/demo/pull/1';
  await app.say(`@fake task demo Add a line\n@@fake write README.md # Demo\\nA line.\n@@fake commit Add a line\n@@fake pr ${url}\n@@fake result Added the line.`);
  await app.until("return (await window.ide.call('state')).tasks.some((x) => x.status === 'pr_open');", 'the task with its PR open');
  await app.evaluate("await window.ide.call('pr:check'); return 1;");
  await app.until("!!document.querySelector('#chat-ins .prmerge')", 'the Merge button');
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

flow("a reply to a Worker's report goes under its card, and so does the Dispatcher's answer", {}, async (app) => {
  // The Worker reports after the Dispatcher's turn has ended, so nothing comes between the card and the reply.
  await app.say('@fake task - Write the notes\n@@fake wait 800\n@@fake result Wrote the notes.');
  const link = '#chat-thread .attach[data-task] [data-action="reply"]';
  await app.until(`!!document.querySelector(${JSON.stringify(link)})`, 'Reply on the result card');
  await app.click(link);
  await app.until("!document.querySelector('#chat-reply').hidden", 'the reply chip on the composer');
  await app.evaluate("const i = document.querySelector('#chat-input'); i.value = 'Why so short?\\n@fake say The notes cover one change.'; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#chat-form').requestSubmit(); return 1;");
  await app.until("document.querySelector('#chat-thread .rth')?.innerText.includes('The notes cover one change.')", "the Dispatcher's answer under the card");
  // One step in, right after the card: the user's question with its branch across, then the answer.
  const shape = await app.evaluate("const g = document.querySelector('#chat-thread .rth'); let p = g.previousElementSibling; while (p && !p.matches('.attach, .bline, .bub, .event')) p = p.previousElementSibling; return { late: g.classList.contains('late'), after: p?.dataset.task ?? null, rows: [...g.querySelectorAll(':scope > .rth-r')].map((r) => r.classList.contains('me') ? 'me' : 'ai'), nested: !!g.querySelector('.rth .rth') };");
  assert.deepEqual(shape, { late: false, after: 'T-0001', rows: ['me', 'ai'], nested: false });
  const chat = (await app.state()).chat;
  assert.deepEqual(chat.filter((c) => c.replyTo).map((c) => [c.kind, c.replyTo]), [['user', 'T-0001'], ['dispatcher', 'T-0001']]);
});

flow('a line run with ! shows its output in the chat, and the Dispatcher gets it with its next turn', {}, async (app) => {
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
  await app.evaluate("document.querySelector('#chat-form').requestSubmit(); return 1;");
  await app.until("document.querySelector('#chat-thread .sh-run')?.innerText.includes('Exit 0')", 'the run block with Exit 0');
  const block = await app.evaluate("const b = document.querySelector('#chat-thread .sh-run'); return { cmd: b.querySelector('code').textContent, out: b.querySelector('.sh-out')?.textContent ?? '', dlv: b.querySelector('.sh-dlv').className };");
  assert.equal(block.cmd, 'node -e "console.log(41 + 1)"');
  assert.match(block.out, /42/);
  assert.match(block.dlv, /wait/, 'waits for the Dispatcher');
  assert.equal(await shellMode(), false, 'a run leaves shell mode');

  // No turn of its own: it goes with the next message.
  await app.say('What did it print?\n@fake echo [Shell run]');
  await app.until("[...document.querySelectorAll('#chat-thread .bub.ai')].some((b) => b.innerText.includes('[Shell run] The user ran'))", 'the run in what the Dispatcher received');
  await app.until("!!document.querySelector('#chat-thread .sh-run .sh-dlv.ok')", '"The Dispatcher has it"');
  const said = await app.evaluate("[...document.querySelectorAll('#chat-thread .bub.ai')].map((b) => b.innerText).join('\\n')");
  // The bubble draws the command's backticks as code.
  assert.match(said, /\[Shell run\] The user ran node -e "console\.log\(41 \+ 1\)" in the IDE home: exit 0/);
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
  await app.until("document.querySelector('.foot-btn[data-action=\"open-settings\"]').classList.contains('has-issue')", 'the dot on the gear');
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
  await app.click('#cmdk-btn');
  await app.evaluate("const q = document.querySelector('#cmdk-q'); q.value = 'pineapple fridays'; q.dispatchEvent(new Event('input', { bubbles: true })); return 1;");
  const row = await app.until("[...document.querySelectorAll('.cmdk-it')].findIndex((el) => el.innerText.includes('no pineapple on Fridays')) + 1", 'the message among the results');
  await app.click(`#cmdk-${row - 1}`);
  await app.until("!!document.querySelector('#chat-thread .found')", 'the message marked in the chat');
  assert.match(await app.evaluate("document.querySelector('#chat-thread .found').innerText"), /no pineapple on Fridays/);
  // The thread now starts at that message: what was said before it is above, not shown.
  assert.equal(await app.evaluate("document.querySelector('#chat-thread').innerText.includes('Please remember the pineapple rule')"), false);
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
  const set = (id, v) => app.evaluate(`const el = document.getElementById(${JSON.stringify(id)}); el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return el.classList.contains('bad');`);
  // Something that is not a time is marked and not saved.
  assert.equal(await set('set-qfrom', 'late'), true);
  assert.equal(await set('set-qfrom', '22'), false);
  assert.equal(await set('set-qto', '7:30'), false);
  await app.click('#set-nres');
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
    return !!((el.getAttribute('aria-label') || '').trim() || (el.title || '').trim() || (el.textContent || '').trim() || labelled || (el.placeholder || '').trim());
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
  const look = async (screen) => { const list = await app.evaluate(NAMELESS); if (list.length) nameless[screen] = list; };
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
  flow('the usage widget names the fuller window, and its popover says when it refreshes and refreshes by hand', { settings: { accounts, usageRefreshMins: 15 } }, async (app) => {
    await app.until("document.querySelectorAll('#usage .uacct').length === 3", 'the rings');
    // The toolbar: the fuller window in words (orange from 80%), the limit that holds an account, a failed read marked.
    assert.deepEqual(await app.evaluate("[...document.querySelectorAll('#usage .uacct')].map((u) => [u.querySelector('.upct')?.textContent ?? u.querySelector('.ulim')?.textContent, !!u.querySelector('.upct.hi'), u.classList.contains('failed')])"),
      [['86% 5h', true, false], [(await app.evaluate("document.querySelector('#usage .ulim').textContent")), false, false], ['20% 5h', false, true]]);
    assert.match(await app.evaluate("document.querySelector('#usage .ulim').textContent"), /^7d limit · until /);
    // The popover, with the foot: the last round, one of three failed, the interval chosen.
    await app.evaluate("document.querySelector('#usage .uacct').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); return 1;");
    await app.until("!document.querySelector('#usage-pop').hidden && !!document.querySelector('#usage-pop .ufoot')", 'the popover foot');
    assert.match(await app.evaluate("document.querySelector('#usage-pop .uft').textContent"), /^Updated .* · 1 of 3 failed$/);
    assert.equal(await app.evaluate("document.querySelector('#usage-pop [data-segc=\"usage-every\"][aria-checked=\"true\"]').dataset.v"), '15');
    // The failed account keeps its figures, dimmed, and the week it has no figure for says so.
    assert.deepEqual(await app.evaluate("const c = document.querySelector('#usage-pop .ua[data-id=\"c\"]'); return [c.classList.contains('old'), !!c.querySelector('time.old'), !!c.querySelector('.cap.none'), c.querySelector('.uw:last-of-type small').textContent];"),
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

flow('the sidebar tab pill follows the sidebar width while it changes', {}, async (app) => {
  await app.click('#chat-ins [data-action="ins-tab"][data-v="auto"]');
  await app.until("document.querySelector('#chat-ins .ins-tabs button.on')?.dataset.v === 'auto'", 'the Automations tab');
  // The pill (the control's ::before, placed by --gx/--gw) against the chosen tab, and how many rows the tabs take.
  const where = `const c = document.querySelector('#chat-ins .ins-tabs'); const on = c.querySelector('button.on');
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
