// End-to-end flows: Pull requests, merges, the automations they fire, and issues handed to the Dispatcher.
// Each flow starts the built app on its own empty profile with fake agents and a stand-in for gh. Run with `npm run e2e`.
import assert from 'node:assert/strict';
import { flow } from './harness.mjs';

const task = (state, title) => state.tasks.find((x) => x.title === title);

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
  assert.ok(app.gh().calls.some((c) => c.startsWith(`pr merge ${url} --squash`)));
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
  const merges = app.gh().calls.filter((c) => c.startsWith('pr merge')).map((c) => c.replace(/ --match-head-commit \w+$/, ''));
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
