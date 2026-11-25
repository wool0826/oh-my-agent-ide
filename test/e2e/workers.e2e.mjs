// End-to-end flows: Workers and their tasks: hand-outs, results, failures, slots, compaction and what is typed for each.
// Each flow starts the built app on its own empty profile with fake agents and a stand-in for gh. Run with `npm run e2e`.
import assert from 'node:assert/strict';
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
  const card = await app.evaluate("[...document.querySelectorAll('#chat-thread .attach .links a')].map((a) => a.innerText).join('|')");
  assert.match(card, /^Release notes ↗\|Open W-\d+ conversation\|Reply$/);
  // In the words, the Markdown link reads its title and the bare URL is a link too.
  assert.equal(await app.evaluate("document.querySelector('#chat-thread .attach .sm').innerText"), 'Published Release notes, see https://claude.ai/artifact/abc123 today.');
  assert.equal(await app.evaluate("document.querySelectorAll('#chat-thread .attach .sm a[data-action=\"open-url\"]').length"), 2);
  await app.until("!!document.querySelector('#chat-ins .res .lk a[data-href=\"https://claude.ai/artifact/abc123\"]')", 'the artifact link on the inbox row');
});

flow('an artifact a report names below its RESULT line reaches the card, the inbox and the Worker', {}, async (app) => {
  const art = 'https://claude.ai/artifact/2hL4515n1HmJCSDrwV96T7';
  await app.say(`@fake task - Audit the UI\n@@fake result Wrote the UI audit.\n@@fake link https://example.com/notes\n@@fake body 아티팩트: ${art}`);
  await app.until(`!!document.querySelector('#chat-thread .attach .links a[data-href="${art}"]')`, 'the artifact link on the result card');
  assert.match(await app.evaluate("[...document.querySelectorAll('#chat-thread .attach .links a')].map((a) => a.innerText).join('|')"), /^example\.com ↗\|Artifact ↗\|Open W-\d+ conversation\|Reply$/);
  await app.until(`!!document.querySelector('#chat-ins .res .lk a[data-href="${art}"]')`, 'the artifact link on the inbox row');
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
