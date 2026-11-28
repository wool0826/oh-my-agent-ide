// End-to-end flows: The rows of docs/REAL-USE-CHECKLIST.md tagged `e2e` that no other flow covered (task F2).
// Each flow names its row. Each starts the built app on its own empty profile with fake agents and a stand-in for gh.
// Run with `npm run e2e`.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { flow, waitFor } from './harness.mjs';

const task = (state, title) => state.tasks.find((x) => x.title === title);
const DEC = '#chat-ins .dec';
const answer = (val) => `${DEC} [data-action="answer"][data-val="${val}"]`;
const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
/** The tree of a worktree's files as they are, committed or not, read the way a checkpoint saves them. */
const worktreeTree = (app, cwd) => {
  const env = { ...process.env, GIT_INDEX_FILE: path.join(app.dir, `index-${Date.now()}`) };
  const run = (...args) => execFileSync('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  run('read-tree', 'HEAD');
  run('add', '-A');
  const tree = run('write-tree');
  fs.rmSync(env.GIT_INDEX_FILE, { force: true });
  return tree;
};
/** Waits until the task with this title has one of these statuses, and returns the state. */
const settled = (app, title, statuses = ['done']) => app.until(`const s = await window.ide.call('state'); return s.tasks.some((x) => x.title === ${JSON.stringify(title)} && ${JSON.stringify(statuses)}.includes(x.status)) && s;`, `"${title}" ${statuses.join(' or ')}`);
/** Runs the half-minute checks as if `ms` had passed (a test hook of the main process). */
const later = (app, ms) => app.evaluate(`await window.ide.call('e2e:clock', ${ms}); return 1;`);
/**
 * What the app was asked to open, as [channel, target]: with fake agents it keeps a file or an address instead of
 * opening it, so a test run starts no editor and no browser.
 */
const opened = (app, what) => app.until("return (async () => { const o = await window.ide.call('e2e:opened'); return o.length && o; })();", what);
/** Opens a Worker's conversation from the sidebar, and its inspector beside it. */
const openWorker = async (app, wid) => {
  await app.click('button[data-v="worker"]');
  const row = `#wk-list [data-action="select-worker"][data-id="${wid}"]`;
  await app.until(`!!document.querySelector('${row}')`, `${wid} in the list of Workers`);
  await app.click(row);
  await app.until(`!!document.querySelector('#ws-tab-chat')`, `the conversation of ${wid}`);
};

// 1.5: a result card's file opens from its link.
flow('row 1.5: the file on a result card opens from its link', {}, async (app) => {
  await app.say('@fake task - Summarize into notes\n@@fake write notes.md The summary.\n@@fake file notes.md\n@@fake result Wrote the notes.');
  await app.until("!!document.querySelector('#chat-ins .res [data-action=\"open-file\"]')", 'the result card with its file');
  await app.click('#chat-ins .res [data-action="open-file"]');
  const asked = await opened(app, 'the file asked to open');
  assert.equal(asked.length, 1);
  assert.equal(asked[0][0], 'open:path');
  assert.equal(path.basename(asked[0][1]), 'notes.md');
  assert.equal(fs.readFileSync(asked[0][1], 'utf8'), 'The summary.\n');
});

// 3.5: a decision left unanswered gives its slot to the queue, and the Worker goes on when answered.
flow('row 3.5: a decision unanswered for longer than the setting gives its slot to the queued task', { settings: { maxWorkers: 1, waitSlotMinutes: 10 } }, async (app) => {
  await app.say('@fake task - Wait for an answer\n@@fake ask Go on? | Yes | No\n@@fake result Went on.\n@fake task - Queued behind\n@@fake result Ran from the queue.');
  await app.until(`!!document.querySelector('${answer('Yes')}')`, 'the question card');
  await settled(app, 'Queued behind', ['queued']);
  // Nine minutes is not enough; ten is.
  await later(app, 0);
  await later(app, 9 * 60_000);
  assert.equal(task(await app.state(), 'Queued behind').status, 'queued');
  await later(app, 10 * 60_000 + 1000);
  let s = await settled(app, 'Queued behind');
  const waiting = task(s, 'Wait for an answer');
  assert.equal(waiting.status, 'waiting');
  assert.match(await app.workerLog(waiting.workerId), /No answer for 10 min: the slot went to the queue\. The Worker goes on when answered\./);
  await app.click(answer('Yes'));
  s = await settled(app, 'Wait for an answer');
  assert.equal(task(s, 'Wait for an answer').summary, 'Went on.');
  assert.match(await app.workerLog(waiting.workerId), /Answer: Yes/);
});

// 4.1: a daily automation hands the Dispatcher its text at its time.
flow('row 4.1: a daily automation added a minute or two ahead runs at its time', {}, async (app) => {
  const at = new Date(Date.now() + 5 * 60_000);
  const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  await app.click('#chat-ins [data-action="ins-tab"][data-v="auto"]');
  await app.until("!!document.getElementById('auto-prompt')", 'the form for a new automation');
  await app.evaluate(`document.getElementById('auto-prompt').value = 'Morning check\\n@fake say The morning check ran.'; document.getElementById('auto-time').value = ${JSON.stringify(hhmm)}; return 1;`);
  await app.click('[data-action="auto-add"]');
  const added = await app.until("return (await window.ide.call('state')).automations[0];", 'the automation in the list');
  assert.deepEqual(added.trigger, { kind: 'daily', time: hhmm, weekdays: false });
  // Before its time nothing runs.
  await later(app, 0);
  assert.equal(await app.evaluate("document.querySelector('#chat-thread').innerText.includes('The morning check ran.')"), false);
  await later(app, 6 * 60_000);
  await app.until("document.querySelector('#chat-thread').innerText.includes('The morning check ran.')", "the automation's turn in the chat");
  const ran = await app.evaluate("return (await window.ide.call('state')).automations[0];");
  assert.ok(ran.lastRunAt);
  assert.ok(Date.parse(ran.nextRunAt) > Date.now() + 20 * 3600_000, `the next run is tomorrow: ${ran.nextRunAt}`);
});

// 5.1: two comments on lines of the Changes tab reach the Worker as one message.
flow('row 5.1: two comments on lines in the Changes tab reach the Worker as one message', { repos: ['demo'] }, async (app) => {
  await app.say('@fake task demo Add a list\n@@fake write list.txt alpha\\nbeta\\ngamma\n@@fake commit Add a list\n@@fake result Added the list.');
  const wid = task(await settled(app, 'Add a list'), 'Add a list').workerId;
  await openWorker(app, wid);
  await app.click('#ws-tab-changes');
  await app.until("[...document.querySelectorAll('#ws-diff .df-h')].some((b) => b.innerText.includes('list.txt'))", 'the changed file');
  await app.evaluate("[...document.querySelectorAll('#ws-diff .df-h')].find((b) => b.innerText.includes('list.txt')).click(); return 1;");
  const comment = async (line, text) => {
    await app.until(`[...document.querySelectorAll('#ws-diff [data-action="diff-note"]')].some((l) => l.textContent === '+${line}')`, `the line ${line}`);
    await app.evaluate(`[...document.querySelectorAll('#ws-diff [data-action="diff-note"]')].find((l) => l.textContent === '+${line}').click(); return 1;`);
    await app.until("!!document.getElementById('dnote-in')", 'the comment box');
    await app.evaluate(`document.getElementById('dnote-in').value = ${JSON.stringify(text)}; return 1;`);
    await app.click('#ws-diff [data-action="diff-note-add"]');
  };
  await comment('alpha', 'Capitalize the first entry.');
  await comment('gamma', '@fake say Applied both comments.');
  await app.until("document.querySelector('[data-action=\"diff-notes-send\"]')?.textContent.includes('2')", 'Send with both comments');
  await app.click('[data-action="diff-notes-send"]');
  await app.until(`return (await window.ide.call('worker:log', ${JSON.stringify(wid)})).items.some((x) => x.text.includes('Applied both comments.') && !x.text.includes('Review comments'));`, 'the Worker acting on them');
  const items = (await app.evaluate(`return (await window.ide.call('worker:log', ${JSON.stringify(wid)})).items;`)).filter((x) => x.text.includes('[Review comments on your changes]'));
  assert.equal(items.length, 1, 'one message');
  assert.match(items[0].text, /list\.txt:1\n> \+?alpha\nCapitalize the first entry\.[\s\S]*list\.txt:3\n> \+?gamma\n@fake say Applied both comments\./);
});

// 5.2: going back to a checkpoint puts the files back and leaves the branch alone; the Worker is told.
flow('row 5.2: going back to a checkpoint puts the files back, keeps the branch and tells the Worker', { repos: ['demo'] }, async (app) => {
  await app.say('@fake task demo Keep notes\n@@fake write notes.txt one\n@@fake commit Add notes\n@@fake result Started the notes.');
  const t = task(await settled(app, 'Keep notes'), 'Keep notes');
  const wid = t.workerId;
  const cwd = (await app.state()).workers.find((w) => w.id === wid).cwd;
  // A message to a Worker reaches it after "[User message] " on its first line, so the script starts on the second.
  const send = async (msg, until, what) => {
    await app.evaluate(`await window.ide.call('worker:send', ${JSON.stringify(wid)}, ${JSON.stringify(`Go on.\n${msg}`)}, []); return 1;`);
    // What the Worker says, not the message that asks it to.
    await app.until(`return (await window.ide.call('worker:log', ${JSON.stringify(wid)})).items.some((x) => x.text.includes(${JSON.stringify(until)}) && !x.text.includes('@fake'));`, what, 20_000, `return (await window.ide.call('worker:log', ${JSON.stringify(wid)})).items.slice(-8).map((x) => x.from + ': ' + x.text.slice(0, 80)).join(' / ');`);
  };
  await send('@fake write notes.txt two\n@fake say Second draft written.', 'Second draft written.', 'the second draft');
  // The checkpoint before a message is saved while the Worker starts on it, so the one before the second draft may
  // hold it already. A message that changes nothing makes sure one does; it is told apart by its files.
  const second = worktreeTree(app, cwd);
  await send('@fake result Read it over.', 'Read it over.', 'the look over');
  const ref = await app.until(`return (await window.ide.call('worker:checkpoints', ${JSON.stringify(wid)})).find((c) => c.tree === ${JSON.stringify(second)})?.ref;`, 'a checkpoint of the second draft');
  await send('@fake write notes.txt three\n@fake say Third draft written.', 'Third draft written.', 'the third draft');
  await app.until(`return (await window.ide.call('state')).workers.find((w) => w.id === ${JSON.stringify(wid)}).status === 'idle';`, 'the Worker idle');
  assert.equal(fs.readFileSync(path.join(cwd, 'notes.txt'), 'utf8'), 'three\n');
  const head = git(cwd, 'rev-parse', 'HEAD'), branch = git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), commits = git(cwd, 'log', '--format=%H');

  await openWorker(app, wid);
  await app.click('#ws-tab-changes');
  await app.until("!!document.querySelector('#ws-diff [data-action=\"ckpt-menu\"]')", 'the Checkpoints button');
  await app.click('#ws-diff [data-action="ckpt-menu"]');
  const item = `.menu.pop .menu-item[data-v="${ref}"]`;
  await app.until(`!!document.querySelector('${item}')`, 'the checkpoints listed');
  await app.click(item);
  await app.until("!!document.querySelector('#ws-diff [data-action=\"ckpt-restore\"]')", 'the question before going back');
  await app.click('#ws-diff [data-action="ckpt-restore"]');
  await app.until(`return (await window.ide.call('worker:log', ${JSON.stringify(wid)})).items.some((x) => x.text === 'The files were put back to a checkpoint.');`, 'the files put back');
  assert.equal(fs.readFileSync(path.join(cwd, 'notes.txt'), 'utf8').replace(/\r\n/g, '\n'), 'two\n', 'the file as it was (git may write it with CRLF)');
  assert.deepEqual([git(cwd, 'rev-parse', 'HEAD'), git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), git(cwd, 'log', '--format=%H')], [head, branch, commits]);
  // The next message tells the Worker, ahead of what it says: the Worker repeats the line it got.
  await app.evaluate(`await window.ide.call('worker:send', ${JSON.stringify(wid)}, 'Go on.\\n@fake echo [Files restored]', []); return 1;`);
  await app.until(`return (await window.ide.call('worker:log', ${JSON.stringify(wid)})).items.some((x) => x.text.startsWith('[Files restored] The user put the files in your worktree back to an earlier checkpoint.') && !x.text.includes('@fake'));`, 'the Worker told');
});

// 5.3: the repository's run command starts from a Worker, shows its output and address, and stops.
flow('row 5.3: a run command starts from a Worker, shows its output, opens its address and stops', { repos: ['demo'] }, async (app) => {
  const cmd = 'node -e "console.log(\'Listening on http://localhost:4321/\'); setInterval(() => {}, 1000)"';
  await app.evaluate(`await window.ide.call('repo:update', 'demo', 'e2e', undefined, ${JSON.stringify(cmd)}); return 1;`);
  await app.say('@fake task demo Look around\n@@fake result Looked.');
  const wid = task(await settled(app, 'Look around'), 'Look around').workerId;
  await openWorker(app, wid);
  await app.until("!!document.querySelector('[data-action=\"run-start\"]')", 'the run command with its Start button');
  await app.click('[data-action="run-start"]');
  await app.until("(document.querySelector('.run-out')?.textContent ?? '').includes('Listening on http://localhost:4321/') && !!document.querySelector('.run-url')", 'the output and the address', 30_000);
  await app.click('.run-url');
  assert.deepEqual(await opened(app, 'the address asked to open'), [['open:external', 'http://localhost:4321/']]);
  await app.click('[data-action="run-stop"]');
  const run = await app.until(`return (await window.ide.call('state')).runs.find((r) => r.workerId === ${JSON.stringify(wid)} && !r.running);`, 'the run stopped', 30_000);
  assert.equal(run.stopped, true);
  await app.until("!document.querySelector('[data-action=\"run-stop\"]') && !!document.querySelector('[data-action=\"run-start\"]') && !document.querySelector('.run-url')", 'Start again in place of Stop');
});

// 13A: each Worker's run gets its own port from the repository's base port; a taken one moves the run up by one.
flow('13A: a run gets PORT and the worktree variables, and a taken port moves it to the next one', { repos: ['demo'] }, async (app) => {
  // $PORT is in the command itself: PowerShell gets it as its own variable, a POSIX shell from the environment.
  const cmd = `node -e "console.log('Listening on http://localhost:' + process.env.PORT + '/ ' + process.env.WORKTREE_NAME + ' arg ' + process.argv[1]); setInterval(() => {}, 1000)" $PORT`;
  const update = (basePort) => app.evaluate(`return await window.ide.call('repo:update', 'demo', 'e2e', undefined, ${JSON.stringify(cmd)}, { basePort: '${basePort}', portStep: 10 }).then(() => 'saved', () => 'refused');`);
  assert.equal(await update(80), 'refused', 'a base port under 1024');
  assert.equal(await update(45000), 'saved');
  await app.say('@fake task demo Look around\n@@fake result Looked.');
  const wid = task(await settled(app, 'Look around'), 'Look around').workerId;
  const want = 45000 + (Number(/\d+$/.exec(wid)[0]) - 1) * 10;
  // Something else holds the Worker's own port.
  const holder = net.createServer();
  await new Promise((resolve) => holder.listen(want, '127.0.0.1', resolve));
  try {
    await openWorker(app, wid);
    await app.until(`(document.querySelector('#wk-ins .kv-port')?.textContent ?? '').includes('${want}')`, 'the port row before the run');
    await app.click('[data-action="run-start"]');
    const next = want + 1;
    await app.until(`(document.querySelector('.run-out')?.textContent ?? '').includes('Listening on http://localhost:${next}/ ${wid} arg ${next}')`, 'the run on the next port with its variables', 30_000);
    await app.until(`(document.querySelector('.run-warn')?.textContent ?? '').includes('${want}') && (document.querySelector('.run-port')?.textContent ?? '') === '${next}' && !!document.querySelector('.kv-port [data-action="open-url"]')`, 'the taken port said, the port it got, and the open button');
    await app.click('[data-action="run-stop"]');
    await app.until(`return (await window.ide.call('state')).runs.some((r) => r.workerId === ${JSON.stringify(wid)} && !r.running);`, 'the run stopped', 30_000);
  } finally {
    holder.close();
  }
  // The repository view lists the variables for its first Worker, and marks a base port out of range.
  await app.click('#views button[data-v="repo"]');
  await app.click('#repo-main [data-action="repo-select"][data-id="demo"]');
  await app.until(`[...document.querySelectorAll('#repo-env .envt td')].map((td) => td.textContent).join(' ').includes('PORT ${want} WORKTREE_NAME ${wid}')`, 'the variables table');
  await app.evaluate("const i = document.querySelector('#repo-port'); i.value = '80'; i.dispatchEvent(new Event('input', { bubbles: true })); return 1;");
  await app.until("!document.querySelector('#repo-port-err').hidden && document.querySelector('#repo-port').getAttribute('aria-invalid') === 'true' && !document.querySelector('#repo-env').textContent.includes('PORT ')", 'the range error and no PORT');
});

// 9.5: the red dot on the gear goes once the sign-in is back and the checks run again.
flow('row 9.5: a missing sign-in puts a dot on the gear, and refreshing after signing in clears it', {
  settings: { githubHost: 'github.company.com' },
  gh: { signedOut: ['github.company.com'] },
}, async (app) => {
  const dot = "document.querySelector('.side-foot [data-action=\"open-settings\"]').classList.contains('has-issue')";
  await app.until(dot, 'the dot on the gear');
  await app.click('[data-action="open-settings"]');
  await app.click('[data-action="pane"][data-id="general"]');
  await app.until("(document.querySelector('#pre-rows .ssum .pill[data-tone=\"danger\"]')?.textContent ?? '') === 'GitHub sign-in'", 'the sign-in named on the status line');
  await app.ghEdit((db) => { db.signedOut = []; });
  await app.click('[data-action="preflight-run"]');
  await app.until(`!(${dot}) && /All \\d+ OK/.test(document.querySelector('#pre-rows').innerText)`, 'the dot gone and every check fine');
  assert.equal((await app.state()).preflightFailed, 0);
});

// 9.7: two files dropped on the quick message box go with the message.
flow('row 9.7: two files dropped on the quick message box go to the chat with the message', {}, async (app) => {
  const files = ['first.txt', 'second.txt'].map((n) => { const p = path.join(app.dir, n); fs.writeFileSync(p, n); return p; });
  const box = await app.openQuick();
  const at = await box.evaluate("const r = document.getElementById('q').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };");
  const data = { items: [], files, dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver', 'drop']) await box.cdp('Input.dispatchDragEvent', { type, ...at, data });
  await box.until("!document.getElementById('files').hidden && document.getElementById('files').textContent === '2 files'", 'the box saying 2 files');
  await box.evaluate("const q = document.getElementById('q'); q.value = 'Look at these'; q.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('f').requestSubmit(); return 1;");
  await box.until("document.getElementById('f').classList.contains('sent')", 'the box saying it was sent');
  const said = await app.until("return (await window.ide.call('state')).chat.find((m) => m.kind === 'user' && m.text.startsWith('Look at these'))?.text;", 'the message in the chat');
  for (const p of files) assert.ok(said.includes(p), `${p} in: ${said}`);
});

// 9.8: an allowance for a task outlives a restart of the app, still listed and still applied.
flow('row 9.8: an "Allow for this task" outlives a restart of the app, listed under the task and still applied', {}, async (app) => {
  await app.say('@fake task - Install across a restart\n@@fake permission npm install a\n@@fake wait 60000\n@@fake result Installed.');
  await app.until(`!!document.querySelector('${answer('allow-task')}')`, 'the permission card');
  await app.click(answer('allow-task'));
  // What the app finds after a restart is what it saved: wait for the allowance on disk.
  const saved = path.join(app.home, 'data', 'state.json');
  const grants = () => { try { return JSON.parse(fs.readFileSync(saved, 'utf8')).tasks.find((x) => x.title === 'Install across a restart')?.grants ?? []; } catch { return []; } };
  await waitFor(() => grants().length, 'The allowance was never saved');
  assert.equal(task(await app.state(), 'Install across a restart').status, 'running');
  await app.restart();
  // The interrupted turn is resumed and ends; the allowance stays on the task.
  let s = await settled(app, 'Install across a restart');
  const t = task(s, 'Install across a restart');
  assert.deepEqual(t.grants, [{ key: 'bash:npm install', label: 'npm install' }]);
  // A follow-up reopens the task: the allowance is listed under it while it runs, and the next install asks nothing.
  await app.evaluate(`await window.ide.call('worker:send', ${JSON.stringify(t.workerId)}, 'One more.\\n@fake ask Install the next one? | Yes | No\\n@fake permission npm install b\\n@fake result Installed again.', []); return 1;`);
  await app.until(`!!document.querySelector('${answer('Yes')}')`, 'the follow-up question');
  await app.click('button[data-v="worker"]');
  await app.click(`#wk-list [data-id="${t.workerId}"]`);
  await app.until("[...document.querySelectorAll('[data-action=\"grant-revoke\"]')].some((b) => b.getAttribute('aria-label').endsWith('npm install'))", 'the allowance listed under the task');
  await app.click('button[data-v="chat"]');
  await app.click(answer('Yes'));
  s = await app.until("return (await window.ide.call('state')).tasks.some((x) => x.summary === 'Installed again.') && (await window.ide.call('state'));", 'the follow-up done');
  assert.equal(s.decisions.filter((d) => d.status === 'pending').length, 0);
  const all = await app.workerLog(t.workerId);
  const log = all.slice(all.lastIndexOf('Install the next one?'));
  assert.match(log, /Allowed for this task: npm install/);
  assert.match(log, /Ran: npm install b/);
});
