// End-to-end flow for the look back in a Worker's Summary tab (T-0112, option A of T-0108): each task's time line and
// permission decisions on its card, and the last seven days of every Worker behind the switch. Run with `npm run e2e`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch } from './harness.mjs';

function flow(name, opts, fn) {
  test(name, { timeout: 120_000 }, async () => {
    const app = await launch(opts);
    try { await fn(app); } finally { await app.stop(); }
  });
}

const DEC = '#chat-ins .dec';
const answer = (val) => `${DEC} [data-action="answer"][data-val="${val}"]`;
const SUM = '#ws-sum';
/** Nothing in the tab runs past its right edge. */
const fits = `const r = document.querySelector('${SUM}'); return r.scrollWidth <= r.clientWidth && [...r.querySelectorAll('.sum-stat, .sum-task, .trow, .prow, .seg')].every((b) => b.getBoundingClientRect().right <= r.getBoundingClientRect().right + 1);`;

flow('the Summary tab looks back: time and permissions per task, and the week across Workers', {}, async (app) => {
  // One task allows an install for the task (the second goes through by that rule); the next is denied a delete.
  await app.say('@fake task - Add the packages\n@@fake permission npm install left-pad\n@@fake permission npm install is-odd\n@@fake result Added them.');
  await app.until(`!!document.querySelector('${answer('allow-task')}')`, 'the install permission card');
  await app.click(answer('allow-task'));
  await app.until("window.ide.call('state').then((s) => s.tasks.some((t) => t.title === 'Add the packages' && t.status === 'done'))", 'the first task done');
  await app.say('@fake task - Clean the build\n@@fake permission rm -rf build\n@@fake result Left the build alone.');
  // The first card may still be leaving: answer the one that names the delete.
  const denyBtn = `[...document.querySelectorAll('${DEC}')].find((c) => c.innerText.includes('rm -rf build'))?.querySelector('[data-action="answer"][data-val="deny"]')`;
  await app.until(`!!${denyBtn}`, 'the delete permission card');
  await app.evaluate(`${denyBtn}.click(); return 1;`);
  await app.until("window.ide.call('state').then((s) => s.tasks.some((t) => t.title === 'Clean the build' && t.status === 'done'))", 'the second task done');
  await app.until("!document.querySelector('#chat-ins .dec[data-dec]')", 'the window told the decision is gone');

  // Each task kept the statuses it went through and its permission decisions.
  const s = await app.state();
  const first = s.tasks.find((t) => t.title === 'Add the packages');
  assert.equal(first.history[0].status, 'queued');
  assert.equal(first.history.at(-1).status, 'done');
  assert.ok(first.history.some((m) => m.status === 'waiting'), JSON.stringify(first.history));
  assert.deepEqual(first.permissions.map((p) => [p.answer, p.answeredAt === null]), [['allow-task', false], ['grant-used', true]]);
  assert.match(first.permissions[1].code, /is-odd/);

  // The Worker's Summary tab: a time line on the card, and its decisions folded under it.
  await app.click('button[data-v="worker"]');
  await app.until(`!!document.querySelector('#wk-list [data-action="select-worker"][data-id="${first.workerId}"]')`, 'the Worker in the list');
  await app.click(`#wk-list [data-action="select-worker"][data-id="${first.workerId}"]`);
  await app.until("!!document.querySelector('#ws-tab-summary')", 'the Summary tab');
  await app.click('#ws-tab-summary');
  const CARD = `${SUM} .sum-task[data-task="${first.id}"]`;
  await app.until(`!!document.querySelector('${CARD} .tl')`, 'the time line on the task card');
  assert.match(await app.evaluate(`document.querySelector('${CARD} .tl-k').innerText`), /Ran \d+m/);
  // A task of seconds still fills its bar.
  assert.ok(await app.evaluate(`const b = document.querySelector('${CARD} .tl'); const w = [...b.children].reduce((a, i) => a + i.getBoundingClientRect().width + 1, 0); return w >= b.getBoundingClientRect().width - 1;`), 'the bar is filled');
  assert.equal(await app.evaluate(`document.querySelector('${CARD} .sum-perms summary').innerText.trim()`), 'Permissions · 2');
  assert.deepEqual(await app.evaluate(`[...document.querySelectorAll('${CARD} .perm-list .prow .pill')].map((p) => p.textContent.trim())`), ['By task rule', 'Allowed for task']);
  assert.ok(await app.evaluate(`[...document.querySelectorAll('${SUM} .sum-stat small')].some((x) => x.innerText === 'Permissions')`));
  assert.equal(await app.evaluate(`document.querySelector('#sum-scope [aria-pressed="true"]').innerText`), first.workerId);

  // The week: every Worker's tasks with their time lines, and the decisions with a filter.
  await app.click('#sum-scope [data-v="week"]');
  await app.until(`document.querySelectorAll('#week-tasks .trow[data-task]').length === 2`, 'both tasks in the week');
  const tile = (label) => app.evaluate(`[...document.querySelectorAll('${SUM} .sum-stat')].find((x) => x.querySelector('small').innerText === ${JSON.stringify(label)})?.querySelector('b').innerText`);
  assert.equal(await tile('Succeeded'), '2 of 2 · 100%');
  assert.equal(await tile('Done again'), '0 of 2 · 0%');
  assert.equal(await tile('Permissions'), '1 allowed · 1 denied');
  assert.equal(await app.evaluate("document.querySelectorAll('#week-tasks .trow .tl').length"), 2);
  assert.equal(await app.evaluate("document.querySelectorAll('#week-perms .prow').length"), 3);
  await app.click('#perm-filter [data-v="denied"]');
  await app.until("document.querySelectorAll('#week-perms .prow').length === 1", 'only the denial');
  assert.match(await app.evaluate("document.querySelector('#week-perms .prow').innerText"), /rm -rf build[\s\S]*Clean the build[\s\S]*Denied/);
  await app.click('#perm-filter [data-v="allowed"]');
  await app.until("document.querySelectorAll('#week-perms .prow').length === 2", 'the two allowed');
  // Selection is shown by the pressed switch alone, never a tint on a row.
  assert.equal(await app.evaluate("[...document.querySelectorAll('#week-tasks .trow, #week-perms .prow')].every((r) => getComputedStyle(r).backgroundColor === 'rgba(0, 0, 0, 0)')"), true);

  // A narrow window, dark and light: nothing runs past the edge.
  await app.size(900);
  for (const theme of ['dark', 'light']) {
    await app.evaluate(`document.documentElement.dataset.theme = '${theme}'; return 1;`);
    assert.equal(await app.evaluate(fits), true, `the week fits at 900px in ${theme}`);
    await app.click('#sum-scope [data-v="worker"]');
    await app.until(`!!document.querySelector('${CARD} .tl')`, 'the Worker again');
    assert.equal(await app.evaluate(fits), true, `the Worker fits at 900px in ${theme}`);
    await app.click('#sum-scope [data-v="week"]');
    await app.until("!!document.querySelector('#week-tasks')", 'the week again');
  }
});
