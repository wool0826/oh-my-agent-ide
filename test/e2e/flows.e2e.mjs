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

flow('with one slot, the second task waits and starts when the first ends', { settings: { maxWorkers: 1 } }, async (app) => {
  await app.say('@fake task - First\n@@fake permission npm run one\n@@fake result One.\n@fake task - Second\n@@fake permission npm run two\n@@fake result Two.');
  await app.until(`!!document.querySelector('${DEC}')`, "the first task's permission card");
  let s = await app.state();
  assert.equal(task(s, 'Second').status, 'queued');
  assert.equal(task(s, 'Second').queueReason, 'slot');
  assert.match(await app.evaluate("document.querySelector('#side').innerText"), /Waiting for a slot 1\/1/);
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
