// End-to-end flows: Workers and their tasks: hand-outs, results, failures, slots, compaction and what is typed for each.
// Each flow starts the built app on its own empty profile with fake agents and a stand-in for gh. Run with `npm run e2e`.
import assert from 'node:assert/strict';
import os from 'node:os';
import { flow } from './harness.mjs';

const task = (state, title) => state.tasks.find((x) => x.title === title);
const DEC = '#chat-ins .dec';
const answer = (val) => `${DEC} [data-action="answer"][data-val="${val}"]`;

flow('a Worker is compacted before its next task, not when its task finishes', {}, async (app) => {
  await app.say('@fake task - Write the release notes\n@@fake tokens 90000\n@@fake result Wrote the release notes.');
  await app.until("!!document.querySelector('#chat-thread .attach[data-task] [data-action=\"reply\"]')", 'the first result');
  let s = await app.state();
  const first = task(s, 'Write the release notes');
  assert.equal(first.status, 'done');
  // Finished with a large context: left as it is, so a follow-up still has all of it.
  assert.equal(s.workers.find((w) => w.id === first.workerId).contextTokens, 90000);
  assert.doesNotMatch(await app.workerLog(first.workerId), /Compact/);
  // The next task on the same Worker: compacted first, then the task message goes out.
  await app.say('@fake task - Polish the release notes\n@@fake result Polished the release notes.');
  await app.until("document.querySelectorAll('#chat-thread .attach[data-task] [data-action=\"reply\"]').length === 2", 'the second result');
  s = await app.state();
  const second = task(s, 'Polish the release notes');
  assert.equal(second.workerId, first.workerId, 'the same Worker took it');
  assert.equal(second.status, 'done');
  const log = await app.workerLog(first.workerId);
  const at = (re) => log.search(re);
  // The conversation shows the task as given, then the compaction, then the work on it.
  assert.ok(at(/Compacting the conversation \(90K\)/) > at(/\[Task T-0002\]/), log);
  assert.ok(at(/Compacted the conversation \(90K → 23K\)/) < at(/RESULT: Polished/), log);
  assert.equal(s.workers.find((w) => w.id === first.workerId).contextTokens, 22500);
});

flow('a URL in a result is a short link on the card and a link in its words', {}, async (app) => {
  await app.say('@fake task - Publish notes\n@@fake result Published [Release notes](https://claude.ai/artifact/abc123), see https://claude.ai/artifact/abc123 today.');
  await app.until("!!document.querySelector('#chat-thread .attach .links a[data-href=\"https://claude.ai/artifact/abc123\"]')", 'the artifact link on the result card');
  // The links, then the icon-only conversation and reply buttons, named by their labels.
  const card = await app.evaluate("[...document.querySelectorAll('#chat-thread .attach .links :is(a, button)')].map((a) => a.innerText || a.getAttribute('aria-label')).join('|')");
  assert.match(card, /^Release notes ↗\|Open W-\d+ conversation\|Reply$/);
  // In the words, the Markdown link reads its title and the bare URL is a link too.
  assert.equal(await app.evaluate("document.querySelector('#chat-thread .attach .sm').innerText"), 'Published Release notes, see https://claude.ai/artifact/abc123 today.');
  assert.equal(await app.evaluate("document.querySelectorAll('#chat-thread .attach .sm a[data-action=\"open-url\"]').length"), 2);
  await app.until("!!document.querySelector('#chat-ins .res .racts a[data-href=\"https://claude.ai/artifact/abc123\"]')", 'the artifact link on the inbox row');
});

flow('an artifact a report names below its RESULT line reaches the card, the inbox and the Worker', {}, async (app) => {
  const art = 'https://claude.ai/artifact/2hL4515n1HmJCSDrwV96T7';
  await app.say(`@fake task - Audit the UI\n@@fake result Wrote the UI audit.\n@@fake link https://example.com/notes\n@@fake body 아티팩트: ${art}`);
  await app.until(`!!document.querySelector('#chat-thread .attach .links a[data-href="${art}"]')`, 'the artifact link on the result card');
  assert.match(await app.evaluate("[...document.querySelectorAll('#chat-thread .attach .links :is(a, button)')].map((a) => a.innerText || a.getAttribute('aria-label')).join('|')"), /^example\.com ↗\|Artifact ↗\|Open W-\d+ conversation\|Reply$/);
  await app.until(`!!document.querySelector('#chat-ins .res .racts a[data-href="${art}"]')`, 'the artifact link on the inbox row');
  const t = task(await app.state(), 'Audit the UI');
  assert.equal(t.summary, 'Wrote the UI audit.');
  assert.deepEqual(t.links, ['https://example.com/notes', art]);
  // The Worker list names them, its side panel links them, and its conversation shows the LINK line as a link.
  await app.click('button[data-v="worker"]');
  assert.match(await app.evaluate("document.querySelector('#wk-list .wrow').innerText"), /Wrote the UI audit\. · example\.com Artifact/);
  await app.click('#wk-list .wrow [data-action="select-worker"]');
  await app.until(`!!document.querySelector('.mini a[data-href="${art}"]')`, 'the artifact link under its tasks');
  await app.until("!!document.querySelector('.bub.wk .rep-l a[data-href=\"https://example.com/notes\"]')", 'the LINK line as a link in the conversation');
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
  // In the chat, a row that needs the user: the task, its Worker, the step it stopped at, and Continue as an icon.
  const FAILED = '#chat-thread .evrow[data-ev="failed"]';
  await app.until(`!!document.querySelector('${FAILED} [data-action="worker-continue"]')`, 'the failure row with Continue');
  assert.match(await app.evaluate(`document.querySelector('${FAILED}').innerText`), /T-\d+\s+Break\s+W-\d+\s+Failed 2\/3/);
  assert.match(await app.evaluate(`document.querySelector('${FAILED} .evt').dataset.tip`), /The build is broken/);
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
  // It waits with no Worker yet (T-0146): its row opens its waiting card, with no Worker selected.
  assert.equal(task(s, 'Second').workerId, null);
  assert.equal(s.workers.length, 1);
  await app.click('#side .q-row [data-action="open-queued"]');
  await app.until("(document.querySelector('#wk-ins .qcard')?.innerText ?? '').includes('Second') && !!document.querySelector('#side .q-row.sel')", 'the waiting card of Second');
  await app.click('button[data-v="chat"]');
  await app.click(answer('allow'));
  // The first finishes, the second takes the slot and asks in its turn.
  await app.until(`(document.querySelector('${DEC}')?.innerText ?? '').includes('npm run two')`, "the second task's permission card");
  await app.click(answer('allow'));
  s = await app.until("return (await window.ide.call('state')).tasks.every((x) => x.status === 'done') && (await window.ide.call('state'));", 'both tasks done');
  assert.equal(s.tasks.length, 2);
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

// A Worker running T-1, with T-2 chained after it on the same Worker (after_task_id): T-2 is last in its taskIds.
const NOW = new Date().toISOString();
const seeded = (id, more) => ({ id, title: `${id} title`, prompt: '', kind: 'other', repo: null, workerId: 'W-01', status: 'running', branch: null, prUrl: null, prState: null, summary: null, files: [], createdAt: NOW, updatedAt: NOW, startedAt: null, finishedAt: null, steps: null, ...more });
/** The Worker declares three steps on its task, marks one, and stays in its turn while the window is looked at. */
const STEPS_SCRIPT = ['@fake steps Read the code | Change it | Report', '@fake step 1', '@fake wait 20000', '@fake result Done.'].join('\n');
const chained = JSON.stringify({
  version: 1,
  workers: [{ id: 'W-01', title: 'T-1 title', model: 'opus', accountId: null, sessionId: null, cwd: os.tmpdir(), repo: null, status: 'running', statusText: '', contextTokens: 0, taskIds: ['T-1', 'T-2'], createdAt: NOW, lastActiveAt: NOW, knowledge: '' }],
  tasks: [seeded('T-1', { prompt: STEPS_SCRIPT }), seeded('T-2', { status: 'blocked', afterTaskId: 'T-1', prompt: '@fake result Done.' })],
  counters: { task: 2, worker: 1 },
});

flow('a follow-up chained after the running task on the same Worker does not hide that task or its steps', { files: { 'data/state.json': chained } }, async (app) => {
  await app.until("window.ide.call('state').then((s) => s.tasks.find((t) => t.id === 'T-1')?.steps?.filter((x) => x.doneAt).length === 1)", 'T-1 has its steps, one done');
  const s = await app.state();
  assert.deepEqual(s.tasks.filter((t) => t.steps?.length).map((t) => t.id), ['T-1'], 'main put the steps on the running task');
  assert.deepEqual(s.openTasks, { 'W-01': 'T-1' });
  // The row of the Running list names the running task and draws its Stepper, not the follow-up waiting after it.
  await app.until("const r = document.querySelector('#side .row[data-id=\"W-01\"]'); return r?.querySelector('.t b')?.textContent === 'T-1 title' && !!r.querySelector('.stp');", 'the W-01 row names T-1 and draws its Stepper');
});

flow('a running row shows a card with its whole title, its steps and what it does now, by hover or keyboard, and Esc closes it', {}, async (app) => {
  const long = 'Lay out the left sidebar below a top strip, keep the traffic lights clear on macOS and check every narrow width';
  await app.say(`@fake task - ${long}\n@@fake steps Reproduce | Fix the wait | Run e2e | Open PR\n@@fake step 1\n@@fake step 2\n@@fake tool gh pr checks 212 --watch\n@@fake wait 60000`);
  await app.until("document.querySelector('#side .rg .row[data-tip-card]')?.innerText.includes('Run e2e')", 'the running row at step 3');
  const CARD = "[document.querySelector('#tip')].find((t) => t.classList.contains('card') && t.classList.contains('on') && !t.hidden)";
  await app.hover('#side .rg .row[data-tip-card] .row-main');
  await app.until(`!!${CARD}?.querySelector('.rc-steps')`, 'the card on hover');
  const c = await app.evaluate(`const t = ${CARD}; return { title: t.querySelector('.rc-t').textContent, steps: [...t.querySelectorAll('.rc-steps li')].map((l) => l.className + ' ' + l.textContent), now: t.querySelector('.rc-now').textContent, n: t.querySelector('.rc-p').textContent, icons: t.querySelectorAll('.rc-steps li.done svg, .rc-steps li.cur svg').length, clicks: getComputedStyle(t).pointerEvents };`);
  assert.equal(c.title, long);
  assert.deepEqual(c.steps, ['done 1. Reproduce', 'done 2. Fix the wait', 'cur 3. Run e2e', 'todo 4. Open PR']);
  assert.match(c.now, /pr checks 212 --watch/);
  assert.equal(c.n, '3/4');
  assert.equal(c.icons, 3);
  assert.equal(c.clicks, 'none');
  await app.key('Escape', 'Escape', 27);
  await app.until(`!${CARD}`, 'the card closed by Esc');
  // A one-line title, opened from the keyboard: the card sits beside the sidebar, inside the window.
  await app.say('@fake task - Fix tip\n@@fake wait 60000');
  await app.until("[...document.querySelectorAll('#side .rg .row[data-tip-card]')].some((r) => r.innerText.includes('Fix tip'))", 'the second running row');
  await app.hover({ x: 700, y: 500 });
  await app.key('ShiftLeft', 'Shift', 16);
  await app.evaluate("[...document.querySelectorAll('#side .rg .row[data-tip-card]')].find((r) => r.innerText.includes('Fix tip')).querySelector('.row-main').focus(); return 1;");
  await app.until(`${CARD}?.querySelector('.rc-t')?.textContent === 'Fix tip'`, 'the one-line card on focus');
  const box = await app.evaluate(`const r = ${CARD}.getBoundingClientRect(); return { left: r.left, right: r.right, side: document.querySelector('#side').getBoundingClientRect().right, w: innerWidth, steps: !!${CARD}.querySelector('.rc-steps') };`);
  assert.ok(box.left >= box.side && box.right <= box.w, JSON.stringify(box));
  assert.equal(box.steps, false);
  assert.equal(await app.evaluate("return document.activeElement.getAttribute('aria-describedby');"), 'tip');
  await app.key('Escape', 'Escape', 27);
  await app.until(`!${CARD} && !document.activeElement.hasAttribute('aria-describedby')`, 'the card closed and the button as it was');
});
