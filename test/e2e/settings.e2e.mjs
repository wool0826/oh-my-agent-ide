// End-to-end flows: Settings and what the app keeps: appearance, do-not-disturb, language, usage, repositories, diagnostics and backups.
// Each flow starts the built app on its own empty profile with fake agents and a stand-in for gh. Run with `npm run e2e`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { flow } from './harness.mjs';

// Hours that hold the moment the flow runs (and pass midnight when they must), and hours that do not.
const hhmm = (h) => `${String((h + 24) % 24).padStart(2, '0')}:00`;
const hour = new Date().getHours();

flow('while do-not-disturb is on, a moon in the sidebar foot says until when and opens the alert settings', { settings: { quietFrom: hhmm(hour - 1), quietTo: hhmm(hour + 2) } }, async (app) => {
  const mark = "const m = document.getElementById('dnd-mark'); return [m.hidden, m.offsetWidth > 0, m.dataset.tip ?? '', m.getAttribute('aria-label') ?? ''];";
  const until = `Do not disturb until ${hhmm(hour + 2)}`;
  assert.deepEqual(await app.evaluate(mark), [false, true, until, until]);
  // Beside the gear, on the same line.
  assert.deepEqual(await app.evaluate("const g = document.querySelector('.side-foot [data-action=\"open-settings\"]').getBoundingClientRect(), m = document.getElementById('dnd-mark').getBoundingClientRect(); return [m.top === g.top, m.left >= g.right, m.left - g.right < 8];"), [true, true, true]);
  await app.click('#dnd-mark');
  await app.until("!!document.getElementById('set-qto')", 'the do-not-disturb fields in Settings');
  // Hours that are over: the mark goes when the settings are saved.
  await app.evaluate(`await window.ide.call('settings:save', { quietFrom: '${hhmm(hour + 3)}', quietTo: '${hhmm(hour + 4)}' }); return 1;`);
  await app.until("document.getElementById('dnd-mark').hidden", 'no mark outside the hours');
  await app.evaluate("await window.ide.call('settings:save', { quietFrom: '', quietTo: '' }); return 1;");
  assert.equal(await app.evaluate("document.getElementById('dnd-mark').hidden"), true);
});

flow('an error from the main process is said in the language of the window', { settings: { language: 'ko' } }, async (app) => {
  const fails = (js) => app.evaluate(`try { ${js}; return ''; } catch (e) { return String(e.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); }`);
  assert.equal(await fails("await window.ide.call('auto:add', '  ', { kind: 'merged' })"), '자동화가 할 일을 적어 주세요.');
  assert.equal(await fails("await window.ide.call('auto:add', 'x', { kind: 'daily', time: '99' })"), '시각은 09:00처럼 써 주세요.');
  assert.equal(await fails("await window.ide.call('auto:update', 'gone', 'x', { kind: 'merged' })"), '없는 항목이에요.');
  // Changing one to nothing is refused the same way, and it stays as it was.
  await app.evaluate("await window.ide.call('auto:add', 'Stays', { kind: 'merged' }); return 1;");
  const id = (await app.evaluate("return (await window.ide.call('state')).automations[0]")).id;
  assert.equal(await fails(`await window.ide.call('auto:update', '${id}', ' ', { kind: 'merged' })`), '자동화가 할 일을 적어 주세요.');
  assert.equal((await app.evaluate("return (await window.ide.call('state')).automations[0]")).prompt, 'Stays');
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
  // Today's copies were made at launch, from the state that was put back: the finished task is in the file for those.
  const backups = path.join(app.home, 'data', 'backups');
  const today = fs.readdirSync(backups).filter((n) => !n.includes('2026-11-0')).sort();
  assert.deepEqual(today.map((n) => n.replace(/\d{4}-\d{2}-\d{2}/, 'DAY')), ['chat-DAY.jsonl', 'state-DAY.json', 'tasks-done-DAY.jsonl']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(backups, today[1]), 'utf8')).tasks, []);
  assert.deepEqual(fs.readFileSync(path.join(backups, today[2]), 'utf8').trim().split('\n').map((l) => JSON.parse(l).title), ['Kept in the backup']);
});

flow('Settings shows what is missing on this computer and the command that fixes it', {
  settings: { githubHost: 'github.company.com' },
  gh: { signedOut: ['github.company.com'] },
}, async (app) => {
  // The launch check puts a dot on the gear without Settings being opened.
  await app.until("document.querySelector('.side-foot [data-action=\"open-settings\"]').classList.contains('has-issue')", 'the dot on the gear');
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

flow('do-not-disturb hours are set in Settings and kept as times', {}, async (app) => {
  await app.click('[data-action="open-settings"]');
  await app.click('[data-action="pane"][data-id="alerts"]');
  // Typing marks what is not a time, for the eye and for a screen reader; leaving the field shows what is kept.
  const type = (id, v) => app.evaluate(`const el = document.getElementById(${JSON.stringify(id)}); el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event('input', { bubbles: true })); return el.classList.contains('bad') + '/' + el.getAttribute('aria-invalid');`);
  const leave = (id) => app.evaluate(`const el = document.getElementById(${JSON.stringify(id)}); el.dispatchEvent(new Event('change', { bubbles: true })); return el.value + '|' + el.classList.contains('bad') + '/' + el.getAttribute('aria-invalid');`);
  assert.equal(await type('set-qfrom', 'late'), 'true/true');
  assert.equal(await leave('set-qfrom'), '|false/null');
  assert.equal(await type('set-qfrom', '22'), 'false/null');
  assert.equal(await leave('set-qfrom'), '22:00|false/null');
  // One time alone switches nothing on: the empty side is marked, and its placeholder does not read as a time.
  assert.equal(await app.evaluate("const el = document.getElementById('set-qto'); return el.placeholder + '|' + el.getAttribute('aria-invalid');"), '--:--|true');
  // A slip of the hand does not switch the hours off: the time in use comes back.
  assert.equal(await type('set-qfrom', '22:6x'), 'true/true');
  assert.equal(await leave('set-qfrom'), '22:00|false/null');
  assert.equal(await type('set-qto', '7:30'), 'false/null');
  assert.equal(await leave('set-qto'), '07:30|false/null');
  // "Notify when a task ends" is off here: its sound cannot be chosen or tried until the switch is on.
  const dsound = "return [...document.querySelectorAll('.dsound-row button')].map((b) => b.disabled).join() + '|' + document.querySelector('.dsound-row').classList.contains('off');";
  assert.match(await app.evaluate(dsound), /^true(,true)+\|true$/);
  await app.click('#set-nres');
  assert.match(await app.evaluate(dsound), /^false(,false)+\|false$/);
  const s = await app.until("return (await window.ide.call('state')).settings.quietTo === '07:30' && (await window.ide.call('state'));", 'the hours saved');
  assert.equal(s.settings.quietFrom, '22:00');
  // The harness saves the old `notifications: false`, which turns task-end notifications off too (notifyDoneFrom); the click turns them on.
  assert.equal(s.settings.notifyDone, true);
  assert.equal(s.settings.notifications, false);
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
  flow('the usage widget shows rings alone, says when a used-up account resets, and its popover says when it refreshes and refreshes by hand', { settings: { accounts, usageRefreshMins: 15 } }, async (app) => {
    await app.until("document.querySelectorAll('#usage .uacct').length === 3", 'the rings');
    // The toolbar: no figures in words; only the used-up account says when it resets; a failed read marked.
    assert.deepEqual(await app.evaluate("[...document.querySelectorAll('#usage .uacct')].map((u) => [!!u.querySelector('.ulim'), u.classList.contains('limited'), u.classList.contains('failed')])"),
      [[false, false, false], [true, true, false], [false, false, true]]);
    assert.match(await app.evaluate("document.querySelector('#usage .ulim').textContent"), /^Resets in 1d [56]h$/);
    assert.doesNotMatch(await app.evaluate("document.querySelector('#usage').textContent"), /%/);
    // The popover, with the foot: the last round, one of three failed, the interval chosen.
    await app.evaluate("document.querySelector('#usage .uacct').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); return 1;");
    await app.until("!document.querySelector('#usage-pop').hidden && !!document.querySelector('#usage-pop .ufoot')", 'the popover foot');
    assert.match(await app.evaluate("document.querySelector('#usage-pop .uft').textContent"), /^Updated .* · 1 of 3 failed$/);
    assert.equal(await app.evaluate("document.querySelector('#usage-pop [data-segc=\"usage-every\"][aria-checked=\"true\"]').dataset.v"), '15');
    // The failed account keeps its figures, dimmed, and the week it has no figure for says so.
    assert.deepEqual(await app.evaluate("const c = document.querySelector('#usage-pop .ua[data-id=\"c\"]'); return [c.classList.contains('old'), !!c.querySelector('time.old'), !!c.querySelector('.meter.none'), c.querySelector('.uw:last-of-type small').textContent];"),
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

flow('the repository list has columns, the sidebar sums up before a pick, and Settings folds what is fine', { repos: ['demo', 'web'] }, async (app) => {
  // Wide enough for every column (a narrow list drops the path, then the branch).
  await app.size(1440);
  await app.click('button[data-v="repo"]');
  await app.until("document.querySelectorAll('#repo-main .li.repo').length === 2", 'the two repositories');
  assert.deepEqual(await app.evaluate("[...document.querySelectorAll('#repo-main .li.repo')].map((r) => [r.querySelector('.c-br').textContent, r.querySelector('.c-path').textContent.endsWith('demo') || r.querySelector('.c-path').textContent.endsWith('web')])"), [['main', true], ['main', true]]);
  assert.equal(await app.evaluate("document.querySelector('#repo-main .li-cols').innerText.replace(/\\s+/g, ' ').trim()"), 'Name Default branch Path');
  // Nothing picked: a summary, not an empty sidebar.
  assert.equal(await app.evaluate("document.querySelector('#repo-ins .kv').innerText.replace(/\\s+/g, ' ').trim()"), 'Repositories 2 Running tasks 0 PRs in review 0');
  // Settings: every check is fine, so the status is one line; the home folder shows both of its ends.
  await app.click('[data-action="open-settings"]');
  await app.click('[data-action="pane"][data-id="general"]');
  await app.until("!!document.querySelector('#pre-rows .pre-all')", 'the status on one line');
  assert.match(await app.evaluate("document.querySelector('#pre-rows .pre-all .pill').textContent"), /^All \d OK$/);
  const home = await app.evaluate("[document.querySelector('#set-home').value, document.querySelector('#set-home-v').textContent]");
  assert.ok(home[1].includes('…') && home[0].endsWith(home[1].split('…').pop()), `home shown as ${home[1]}`);
});

flow('the stay-awake switch is in Settings and holds the computer awake only while it is on and a Worker works', {}, async (app) => {
  const held = () => app.evaluate("return await window.ide.call('e2e:awake');");
  assert.equal(await held(), false);
  // A Worker waiting on an approval is still working.
  await app.say(['@fake task - Update the changelog', '@@fake permission npm install left-pad'].join('\n'));
  await app.until("!!document.querySelector('#chat-ins .dec')", 'the decision waiting');
  await app.until("return await window.ide.call('e2e:awake');", 'the computer held awake');
  await app.click('[data-action="open-settings"]');
  await app.click('[data-action="pane"][data-id="general"]');
  assert.equal(await app.evaluate("const el = document.getElementById('set-awake'); return el.checked + '|' + !!el.closest('.srow').querySelector('.lbl-note')?.textContent;"), 'true|true');
  await app.click('#set-awake');
  await app.until("return (await window.ide.call('state')).settings.keepAwake === false;", 'the switch saved off');
  assert.equal(await held(), false);
  await app.click('#set-awake');
  await app.until("return (await window.ide.call('state')).settings.keepAwake === true;", 'the switch saved on');
  await app.until("return await window.ide.call('e2e:awake');", 'the computer held awake again');
});
