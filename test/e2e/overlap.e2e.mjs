// End-to-end flow for the file overlap warning (T-0107): a new task that names a file another task's branch already
// changes is still created, the Dispatcher hears which task and files, and the Workers view shows it in one line.
// Run with `npm run e2e`.
import assert from 'node:assert/strict';
import { flow } from './harness.mjs';

const said = (s, id) => s.chat.map((c) => c.text).find((t) => t.startsWith(`${id} assigned to`)) ?? '';

flow('a task naming a file that work in progress changes is created with a warning', { repos: ['demo'] }, async (app) => {
  await app.say('@fake task demo Restyle the list\n@@fake write src/styles.css a {}\n@@fake commit Restyle\n@@fake pr https://github.com/o/demo/pull/1\n@@fake result Restyled.');
  await app.until("window.ide.call('state').then((s) => (s.tasks[0]?.changedFiles ?? []).includes('src/styles.css'))", 'the first branch\'s files recorded');
  const first = (await app.state()).tasks[0];
  assert.equal(first.status, 'pr_open');

  // A task's prompt is its "@@fake" lines, so the paths are named there.
  await app.say('@fake task demo Tweak the colours\n@@fake say Editing src/styles.css.\n@@fake blocked Which colours?\n@fake task demo Fix the title\n@@fake say Editing README.md.\n@@fake blocked Which title?');
  await app.until("window.ide.call('state').then((s) => s.tasks.length === 3 && s.tasks.every((t) => t.workerId))", 'both new tasks assigned');
  const s = await app.state();
  const [, overlapping, apart] = s.tasks;
  // Created either way; only the one naming the changed file hears about it.
  assert.deepEqual(overlapping.overlaps, [{ taskId: first.id, files: ['src/styles.css'] }]);
  assert.equal(apart.overlaps ?? null, null);
  const warn = said(s, overlapping.id);
  assert.match(warn, new RegExp(`Overlap: ${first.id} "Restyle the list" \\(W-\\d+, PR open\\) already changes src/styles\\.css\\. If ${overlapping.id} must build on that work, .* after_task_id "${first.id}"`));
  assert.doesNotMatch(said(s, apart.id), /Overlap/);
  console.log(`overlapping: ${warn}\nnot overlapping: ${said(s, apart.id)}`);

  // The Workers view says it in one line on the overlapping task.
  await app.until(`window.ide.call('state').then((s) => s.tasks.find((t) => t.id === '${overlapping.id}').status === 'waiting')`, 'the task waiting');
  await app.click('button[data-v="worker"]');
  await app.until(`!!document.querySelector('#wk-list [data-action="select-worker"][data-id="${overlapping.workerId}"]')`, 'the Worker in the list');
  await app.click(`#wk-list [data-action="select-worker"][data-id="${overlapping.workerId}"]`);
  await app.until("[...document.querySelectorAll('#wk-ins .kv > span')].some((x) => x.innerText === 'Overlaps')", 'the overlap line');
  const line = await app.evaluate("[...document.querySelectorAll('#wk-ins .kv > span')].find((x) => x.innerText === 'Overlaps').nextElementSibling.innerText");
  assert.equal(line, `${first.id} styles.css`);
});
