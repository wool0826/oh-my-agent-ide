// End-to-end flows: The merge queue: ready PRs merged one at a time, each on the base the one before it left.
// Each flow starts the built app on its own empty profile with fake agents and a stand-in for gh. Run with `npm run e2e`.
// In the stand-in a merge leaves the repository's other open PRs behind their base, and `update-branch` gives a PR a
// new head with the fields of its `afterUpdate` (see gh-stub.mjs).
import assert from 'node:assert/strict';
import { flow } from './harness.mjs';

const pr = (n) => `https://github.com/o/demo/pull/${n}`;
const one = (n) => `@fake task demo Change ${n}\n@@fake write file${n}.txt ${n}\n@@fake commit Change ${n}\n@@fake pr ${pr(n)}\n@@fake result Changed ${n}.`;
/** One check named "test": passed, failed, or still running when no conclusion is given. */
const check = (conclusion) => [conclusion ? { name: 'test', status: 'COMPLETED', conclusion } : { name: 'test', status: 'IN_PROGRESS' }];
const open = (fields = {}) => ({ state: 'OPEN', mergeable: 'MERGEABLE', reviewDecision: 'APPROVED', checks: check('SUCCESS'), ...fields });
const task = (state, title) => state.tasks.find((x) => x.title === title);

/** One round of the queue's runner now, not at its next tick. */
const RUN = "await window.ide.call('mq:run');";
/** The queue's rows in the Workers view, each as one line of text. */
const ROWS = "[...document.querySelectorAll('#wk-list .mq-row')].map((r) => r.innerText.replace(/\\s+/g, ' ').trim())";
const rows = (app) => app.evaluate(`return ${ROWS};`);
/** What the queue asked of GitHub, in order: "merge 1", "update 2". */
const asked = (app) => app.gh().calls.map((c) => {
  const m = /^pr merge \S+\/pull\/(\d+)/.exec(c);
  const u = /pulls\/(\d+)\/update-branch/.exec(c);
  return m ? `merge ${m[1]}` : u ? `update ${u[1]}` : '';
}).filter(Boolean);
const mergedCount = (n) => `${RUN} return (await window.ide.call('state')).tasks.filter((x) => x.prState === 'MERGED').length === ${n};`;

/** Opens n PRs (Change 1..n), shows the Workers view, and puts them all in the queue with "Merge n". */
async function queueAll(app, n) {
  await app.say(Array.from({ length: n }, (_, i) => one(i + 1)).join('\n'));
  await app.until(`return (await window.ide.call('state')).tasks.filter((x) => x.status === 'pr_open').length === ${n};`, `${n} PRs open`);
  await app.until(`await window.ide.call('pr:check'); return document.querySelector('[data-action="pr-merge-all"]')?.textContent === 'Merge ${n}';`, `"Merge ${n}" in the sidebar`);
  await app.click('#views button[data-v="worker"]');
  await app.click('[data-action="pr-merge-all"]');
  await app.click('[data-action="pr-merge-all"]');
}

flow('two PRs merge in order, the second on the base the first one left', {
  repos: ['demo'], gh: { prs: { [pr(1)]: open(), [pr(2)]: open({ afterUpdate: { checks: check() } }) } },
}, async (app) => {
  await queueAll(app, 2);
  // The first is merged, which leaves the second behind: the base goes into its branch and it waits for the new checks.
  await app.until(`${RUN} return ${ROWS}.some((r) => /#2 Change 2 demo · Waiting for checks/.test(r));`, 'the second PR waiting for its checks in the Workers view');
  assert.equal(app.gh().prs[pr(1)].state, 'MERGED');
  assert.equal(app.gh().prs[pr(2)].state, 'OPEN');
  assert.deepEqual(asked(app), ['merge 1', 'update 2']);
  // In line, its own Merge button says so and does nothing; the sidebar opens the queue.
  assert.equal(await app.evaluate("document.querySelector('#side .h-act[data-action=\"worker-filter\"]')?.textContent"), 'Queue 1');
  // The checks of the new head pass: it is merged, at the commit they ran on.
  await app.ghPr(pr(2), { checks: check('SUCCESS') });
  await app.until(mergedCount(2), 'both PRs merged');
  assert.deepEqual(asked(app), ['merge 1', 'update 2', 'merge 2']);
  const head = app.gh().prs[pr(2)].headOid;
  assert.ok(app.gh().calls.includes(`pr merge ${pr(2)} --squash --match-head-commit ${head}`), 'merged at the updated head');
  await app.until("!document.querySelector('#wk-list .mq')", 'the queue gone from the Workers view');
});

flow('a PR whose checks fail after the update leaves the queue, and the next one is merged', {
  repos: ['demo'], gh: { prs: { [pr(1)]: open(), [pr(2)]: open({ afterUpdate: { checks: check('FAILURE') } }), [pr(3)]: open() } },
}, async (app) => {
  await queueAll(app, 3);
  await app.until(mergedCount(2), 'the first and the third PR merged');
  const s = await app.state();
  assert.equal(task(s, 'Change 2').prState, 'OPEN');
  assert.equal(app.gh().prs[pr(2)].state, 'OPEN');
  assert.deepEqual(asked(app), ['merge 1', 'update 2', 'update 3', 'merge 3']);
  // It stays listed with the reason, the chat says so, and its Worker gets the failure to fix.
  await app.until(`return ${ROWS}.length === 1 && /#2 Change 2 demo · Left: checks failed/.test(${ROWS}[0]);`, 'the second PR listed as left');
  const wid = task(s, 'Change 2').workerId;
  await app.until(`return (await window.ide.call('worker:log', ${JSON.stringify(wid)})).items.some((x) => x.text.includes('CI checks failed'));`, 'the CI failure with its Worker');
  // Once its checks pass it can go back in, at the back.
  await app.ghPr(pr(2), { checks: check('SUCCESS') });
  await app.until(`await window.ide.call('pr:check'); return !!document.querySelector('#wk-list .mq-row [data-action="mq-again"]');`, 'the button that puts it back');
  await app.click('#wk-list .mq-row [data-action="mq-again"]');
  await app.until(mergedCount(3), 'the second PR merged too');
  await app.click('#views button[data-v="chat"]');
  await app.until("document.querySelector('#chat-thread')?.innerText.includes('Change 2: left the merge queue (checks failed)')", 'the chat event');
});

flow('a PR that conflicts with the new base leaves the queue and goes to its Worker', {
  repos: ['demo'], gh: { prs: { [pr(1)]: open(), [pr(2)]: open({ conflictOnUpdate: true }), [pr(3)]: open() } },
}, async (app) => {
  await queueAll(app, 3);
  await app.until(mergedCount(2), 'the first and the third PR merged');
  const s = await app.state();
  assert.equal(task(s, 'Change 2').prState, 'OPEN');
  assert.deepEqual(asked(app), ['merge 1', 'update 2', 'update 3', 'merge 3']);
  await app.until(`return ${ROWS}.some((r) => /#2 Change 2 demo · Left: conflict, sent to its Worker/.test(r));`, 'the second PR listed as left');
  const wid = task(s, 'Change 2').workerId;
  await app.until(`return (await window.ide.call('worker:log', ${JSON.stringify(wid)})).items.some((x) => x.text.includes('The PR conflicts with its base'));`, 'the conflict with its Worker');
  // The PR watch sees the same conflict at its next round and does not send it a second time.
  await app.evaluate("await window.ide.call('pr:check'); return 1;");
  const log = await app.workerLog(wid);
  assert.equal(log.split('The PR conflicts with its base').length - 1, 1);
});

flow('a PR taken out of the queue in the Workers view is not merged', {
  repos: ['demo'], gh: { prs: { [pr(1)]: open(), [pr(2)]: open({ afterUpdate: { checks: check() } }) } },
}, async (app) => {
  await queueAll(app, 2);
  await app.until(`${RUN} return ${ROWS}.some((r) => /#2 Change 2 demo · Waiting for checks/.test(r));`, 'the second PR waiting for its checks');
  await app.click('#wk-list .mq-row [data-action="mq-remove"]');
  await app.until("!document.querySelector('#wk-list .mq')", 'the queue empty');
  // Its checks pass after that: nothing merges it.
  await app.ghPr(pr(2), { checks: check('SUCCESS') });
  await app.evaluate(`${RUN} await window.ide.call('pr:check'); ${RUN} return 1;`);
  const s = await app.state();
  assert.deepEqual(s.mergeQueue, []);
  assert.equal(task(s, 'Change 2').prState, 'OPEN');
  assert.equal(app.gh().prs[pr(2)].state, 'OPEN');
  assert.deepEqual(asked(app), ['merge 1', 'update 2']);
});

// The app quit while the PR at the front waited for the checks of its updated head: the saved queue goes on.
const at = new Date().toISOString();
const saved = {
  tasks: [{
    id: 'T-1', title: 'Change 1', prompt: 'Change 1', kind: 'code', repo: null, workerId: null, status: 'pr_open', branch: 'agent/t-1',
    prUrl: pr(1), prState: 'OPEN', summary: null, files: [], createdAt: at, updatedAt: at, finishedAt: at, reviewSyncedAt: null, seenCommentIds: [],
  }],
  mergeQueue: [{ taskId: 'T-1', prUrl: pr(1), phase: 'checks', since: at, updatedFrom: 'a'.repeat(40), updates: 1, expectChecks: true }],
};

flow('a queue that was at work when the app quit goes on at the next start', {
  files: { 'data/state.json': JSON.stringify(saved) }, gh: { prs: { [pr(1)]: open({ headOid: 'c'.repeat(40) }) } },
}, async (app) => {
  await app.until("return (await window.ide.call('state')).tasks.some((x) => x.id === 'T-1' && x.prState === 'MERGED');", 'the queued PR merged after the start');
  assert.deepEqual(asked(app), ['merge 1']);
  assert.deepEqual((await app.state()).mergeQueue, []);
});
