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
  await app.until("!!document.querySelector('#pre-rows .ssum')", 'the status summary');
  // Closed: one line, with what needs something by name and how many are fine. Fake agents need no account.
  const pills = "[...document.querySelectorAll('#pre-rows .ssum .pill')].map((p) => [p.textContent, p.dataset.tone])";
  assert.deepEqual(await app.evaluate(pills), [['GitHub sign-in', 'danger'], ['OK 4', 'success']]);
  assert.equal(await app.evaluate("document.querySelectorAll('#pre-rows .sitem').length"), 0);
  // Open: what failed first, each row its state icon, its name and a short value; no sentence or command on the row.
  await app.click('#pre-rows .ssum [data-action="status-fold"]');
  await app.until("document.querySelectorAll('#pre-rows .sitem').length === 5", 'the five rows');
  const rows = await app.evaluate("[...document.querySelectorAll('#pre-rows .sitem')].map((r) => [r.querySelector('.sic').getAttribute('aria-label'), r.querySelector('.lbl').textContent, r.querySelector('.v').textContent])");
  assert.deepEqual(rows[0], ['Needed', 'GitHub sign-in: github.company.com', 'Not signed in']);
  assert.deepEqual(rows.slice(1).map((r) => [r[0], r[1]]), [['OK', 'git'], ['OK', 'GitHub CLI (gh)'], ['OK', 'GitHub sign-in: github.com'], ['OK', 'IDE home folder']]);
  assert.equal(await app.evaluate("document.activeElement?.dataset.v"), 'pre', 'the focus stays on the summary disclosure');
  // A row opened: its detail holds the command and the message from gh whole, each with a copy button.
  // Every disclosure and copy control is a real button, so Tab reaches it and Enter or Space presses it.
  assert.deepEqual(await app.evaluate("[...new Set([...document.querySelectorAll('#pre-rows [data-action]')].map((b) => b.tagName + ':' + b.type))]"), ['BUTTON:button']);
  const first = '#pre-rows .sitem [data-action="status-fold"]';
  await app.click(first);
  await app.until("!!document.querySelector('#pre-rows .sdet')", 'the first row open');
  assert.equal(await app.evaluate(`document.querySelector('${first}').getAttribute('aria-expanded')`), 'true');
  const kv = await app.evaluate("[...document.querySelectorAll('#pre-rows .skv dt')].map((d) => [d.textContent, d.nextElementSibling.textContent, d.nextElementSibling.nextElementSibling.getAttribute('aria-label')])");
  assert.deepEqual(kv[0], ['Run', 'gh auth login --hostname github.company.com', 'Copy: Run']);
  assert.equal(kv[1][0], 'Error');
  await app.click('#pre-rows .skv [data-action="status-copy"]');
  await app.until("(document.querySelector('.toast')?.innerText ?? '').includes('Copied')", 'the copied toast');
  // Narrow: nothing runs out of the group sideways.
  await app.size(900);
  assert.deepEqual(await app.evaluate("[...document.querySelectorAll('#pre-rows .ssum, #pre-rows .sitem, #pre-rows .sdet')].filter((r) => r.scrollWidth > r.clientWidth + 1).map((r) => r.className)"), []);
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

flow('Settings in a small window zoomed in keeps every row inside its card and does not scroll sideways', {}, async (app) => {
  await app.click('[data-action="open-settings"]');
  // 760×640 at 150% zoom is this much page.
  await app.size(507, 427);
  for (const id of ['accounts', 'general', 'display', 'alerts', 'memory', 'models']) {
    await app.click(`[data-action="pane"][data-id="${id}"]`);
    await app.until(`document.querySelector('[data-action="pane"][data-id="${id}"]').classList.contains('on') && !!document.querySelector('.spanes .srow')`, `the ${id} pane`);
    // Every row and account card is inside the pane's column, and what a row holds is inside the row.
    const r = await app.evaluate(`const p = document.querySelector('.spanes'); const col = p.querySelector('.sinner').getBoundingClientRect();
      const past = (el, b) => { const e = el.getBoundingClientRect(); return e.width > 0 && (e.right > b.right + 1 || e.left < b.left - 1); };
      const out = [...p.querySelectorAll('.srow, .acc-card')].flatMap((row) => [...(past(row, col) ? [row] : []), ...[...row.children].filter((el) => past(el, row.getBoundingClientRect()))]).map((el) => el.className || el.tagName);
      return { sideways: p.scrollWidth - p.clientWidth, out };`);
    assert.deepEqual(r, { sideways: 0, out: [] }, id);
    // The volume slider keeps a length that can be dragged.
    if (id === 'alerts') assert.ok(await app.evaluate("return document.querySelector('.srow.vol .slider-wrap').getBoundingClientRect().width;") >= 120);
  }
  // The nav gave room, and the title stays whole next to Back.
  assert.deepEqual(await app.evaluate("const h = document.querySelector('.stopbar h1'); return [document.querySelector('.snav').offsetWidth, h.scrollWidth <= h.clientWidth && h.offsetWidth > 0];"), [168, true]);
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
  flow('the usage widget shows rings alone, the warning chip says when a used-up account comes back, and its popover says when it refreshes and refreshes by hand', { settings: { accounts, usageRefreshMins: 15 } }, async (app) => {
    await app.until("document.querySelectorAll('#usage .uacct').length === 3", 'the rings');
    // The toolbar: no figures in words by the rings; the used-up account is red and the chip says when it comes back; a failed read marked.
    assert.deepEqual(await app.evaluate("[...document.querySelectorAll('#usage .uacct')].map((u) => [u.classList.contains('limited'), u.classList.contains('failed')])"),
      [[false, false], [true, false], [false, true]]);
    await app.until("!document.querySelector('#usage-warn').hidden", 'the limit chip');
    const back = await app.evaluate("const d = new Date(Date.now() + 1800 * 60_000); return d.toLocaleDateString('en-US', { weekday: 'short' }) + ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });");
    assert.deepEqual(await app.evaluate("const c = document.querySelector('#usage-warn'); return [c.dataset.tone, c.textContent, c.getAttribute('aria-label')];"),
      ['danger', `Limit · ${back}`, `Usage warning · Team B · Limit · ${back}`]);
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
    // eslint-disable-next-line no-restricted-syntax -- a round in the same millisecond as the last would leave checkedAt the same, so the wait below could not see it.
    await app.evaluate("await new Promise((r) => setTimeout(r, 20)); document.querySelector('#usage-pop .ubtn').click(); return 1;");
    await app.until(`return (await window.ide.call('state')).usageClock.checkedAt !== ${JSON.stringify(before)};`, 'a new round');
    // A click on refresh leaves the focus in the popover; it still closes as the pointer leaves, by a press outside, and by Escape.
    const shut = "document.querySelector('#usage-pop').hidden || document.querySelector('#usage-pop').classList.contains('out')";
    const openAndRefresh = async () => {
      await app.until(`return (await window.ide.call('state')).usageClock.running === false;`, 'no round running');
      await app.hover('#usage .uacct');
      await app.until("!document.querySelector('#usage-pop').hidden && !document.querySelector('#usage-pop').classList.contains('out')", 'the popover open');
      await app.hover('#usage-pop .ubtn');
      const p = await app.evaluate("const r = document.querySelector('#usage-pop .ubtn').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };");
      await app.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', buttons: 1, clickCount: 1 });
      await app.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button: 'left', buttons: 0, clickCount: 1 });
      assert.equal(await app.evaluate("document.activeElement?.closest('#usage-pop') ? 'in' : 'out'"), 'in');
    };
    // Low on the left of the content, away from the popover (it hangs below the rings, on the right).
    const far = await app.evaluate("const r = document.querySelector('.content').getBoundingClientRect(); return { x: Math.round(r.left + 40), y: Math.round(r.bottom - 60) };");
    await app.key('Escape', 'Escape', 27);
    await app.until(`return ${shut};`, 'the popover closed before');
    await openAndRefresh();
    await app.hover(far);
    await app.until(`return ${shut};`, 'the popover closed as the pointer left');
    // The round's answer comes after the pointer left: the popover stays closed.
    await app.until(`return (await window.ide.call('state')).usageClock.running === false;`, 'the round done');
    assert.equal(await app.evaluate(`return ${shut};`), true);
    await openAndRefresh();
    await app.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...far, button: 'left', buttons: 1, clickCount: 1 });
    await app.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...far, button: 'left', buttons: 0, clickCount: 1 });
    // At once, not by the pointer's leave a moment later.
    assert.equal(await app.evaluate(`return ${shut};`), true, 'the popover closed by a press outside');
    await openAndRefresh();
    await app.key('Escape', 'Escape', 27);
    await app.until(`return ${shut};`, 'the popover closed by Escape');
    // The popover's buttons are reached with the keyboard from the rings, and Escape brings the focus back.
    await app.evaluate("document.querySelector('#usage').focus(); document.querySelector('#usage').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); return 1;");
    assert.equal(await app.evaluate("document.activeElement?.closest('#usage-pop') ? 'in' : 'out'"), 'in');
    // A narrow window keeps the rings alone; in a short one (a small window zoomed in) the popover scrolls, so its foot is reached.
    await app.key('Escape', 'Escape', 27);
    await app.until(`return ${shut};`, 'the popover closed before the narrow window');
    await app.size(900, 427);
    await app.until("getComputedStyle(document.querySelector('#usage-warn .ut')).display === 'none'", 'the chip with its icon alone in a narrow window');
    assert.deepEqual(await app.evaluate("const r = document.querySelector('#usage-warn').getBoundingClientRect(); return [r.width, r.height];"), [32, 32]);
    await app.hover('#usage .uacct');
    await app.until("!document.querySelector('#usage-pop').hidden && !document.querySelector('#usage-pop').classList.contains('out')", 'the popover open in the short window');
    assert.deepEqual(await app.evaluate(`const p = document.querySelector('#usage-pop'), b = p.querySelector('.ubtn');
      const inside = p.getBoundingClientRect().bottom <= innerHeight, scrolls = p.scrollHeight > p.clientHeight;
      b.scrollIntoView({ block: 'nearest' });
      return { inside, scrolls, foot: b.getBoundingClientRect().bottom <= innerHeight };`), { inside: true, scrolls: true, foot: true });
  });

  flow('past the warning threshold a chip says the window, its use and when it runs out; it opens the popover, notifies once and follows the settings', { settings: { accounts: [accounts[0], accounts[2]] } }, async (app) => {
    await app.until("document.querySelectorAll('#usage .uacct').length === 2", 'the rings');
    // 86% is under the 90% threshold: no chip.
    assert.equal(await app.evaluate("document.querySelector('#usage-warn').hidden"), true);
    const reset = JSON.stringify(accounts[0].fiveHour.resetsAt);
    // A session reports 91%: the chip, in orange, with the forecast (the 5h window began 230 min ago, so 9% more lasts about 23 min).
    await app.evaluate(`await window.ide.call('e2e:usage', 'a', 91, ${reset}); return 1;`);
    await app.until("!document.querySelector('#usage-warn').hidden", 'the warning chip');
    assert.equal(await app.evaluate("document.querySelector('#usage-warn').dataset.tone"), 'warning');
    const chip = await app.evaluate("document.querySelector('#usage-warn').textContent");
    assert.match(chip, /^5h 91% · \d{1,2}:\d\d [AP]M$/);
    const runsOut = await app.evaluate("return new Date(Date.now() + 23 * 60_000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });");
    const mins = (hm) => { const [, h, m, ap] = /(\d+):(\d+) ([AP])M/.exec(hm); return ((Number(h) % 12) + (ap === 'P' ? 12 : 0)) * 60 + Number(m); };
    assert.ok(Math.abs(mins(chip.split(' · ')[1]) - mins(runsOut)) % (24 * 60) <= 2, 'the forecast about 23 min away');
    // One OS notification for the crossing, none for a later reading in the same window.
    assert.deepEqual(await app.evaluate("return window.ide.call('e2e:usageNotes');"), [`Team A 5h 91% · runs out ${chip.split(' · ')[1]}`]);
    await app.evaluate(`await window.ide.call('e2e:usage', 'a', 93, ${reset}); return 1;`);
    await app.until("document.querySelector('#usage-warn').textContent.startsWith('5h 93%')", 'the chip at 93%');
    assert.deepEqual(await app.evaluate("return window.ide.call('e2e:usageNotes');"), [`Team A 5h 91% · runs out ${chip.split(' · ')[1]}`]);
    // A click opens the popover and holds it: the account is marked, its window's note is orange, the forecast follows.
    await app.click('#usage-warn');
    await app.until("!document.querySelector('#usage-pop').hidden && !document.querySelector('#usage-pop').classList.contains('out')", 'the popover from the chip');
    assert.deepEqual(await app.evaluate("const a = document.querySelector('#usage-pop .ua[data-id=\"a\"]'), c = document.querySelector('#usage-pop .ua[data-id=\"c\"]'); return [a.classList.contains('warn'), !!a.querySelector('.uw small.warn'), c.classList.contains('warn'), document.querySelector('#usage-warn').getAttribute('aria-expanded')];"),
      [true, true, false, 'true']);
    assert.match(await app.evaluate("document.querySelector('#usage-pop .ua[data-id=\"a\"] .ufc').textContent"), /^Runs out \d{1,2}:\d\d [AP]M · resets \d{1,2}:\d\d [AP]M$/);
    const far = await app.evaluate("const r = document.querySelector('.content').getBoundingClientRect(); return { x: Math.round(r.left + 40), y: Math.round(r.bottom - 60) };");
    await app.hover('#usage .uacct');
    await app.hover(far);
    await app.until("document.querySelector('#usage-pop').matches(':not(:hover)')", 'the pointer away');
    assert.equal(await app.evaluate("document.querySelector('#usage-pop').hidden || document.querySelector('#usage-pop').classList.contains('out')"), false, 'held open as the pointer leaves');
    await app.click('#usage-warn');
    await app.until("document.querySelector('#usage-pop').hidden || document.querySelector('#usage-pop').classList.contains('out')", 'closed by the chip again');
    // Ctrl/Cmd+Shift+U: open with the focus in it, and shut again.
    const mod = process.platform === 'darwin' ? 4 : 2;
    await app.key('KeyU', 'U', 85, mod | 8);
    await app.until("!document.querySelector('#usage-pop').hidden && !!document.activeElement?.closest('#usage-pop')", 'the popover with the focus in it');
    await app.key('KeyU', 'U', 85, mod | 8);
    await app.until("document.querySelector('#usage-pop').hidden || document.querySelector('#usage-pop').classList.contains('out')", 'closed by the keys again');
    // Settings > Accounts: the group, with 90% chosen; without the forecast the chip keeps the window and its use; at 95% it goes.
    await app.click('[data-action="open-settings"]');
    await app.click('[data-action="pane"][data-id="accounts"]');
    await app.until("!!document.querySelector('[data-segc=\"set-uwarn\"][aria-checked=\"true\"]')", 'the threshold');
    assert.deepEqual(await app.evaluate("[document.querySelector('[data-segc=\"set-uwarn\"][aria-checked=\"true\"]').dataset.v, document.querySelector('#set-ufc').checked, document.querySelector('#set-unoti').checked, document.querySelector('#set-uswitch').checked]"),
      ['90', true, true, false]);
    await app.click('#set-ufc');
    await app.until("document.querySelector('#usage-warn').textContent === '5h 93%'", 'the chip without the forecast');
    await app.click('[data-segc="set-uwarn"][data-v="95"]');
    await app.until("return (await window.ide.call('state')).settings.usageWarnAt === 95 && document.querySelector('#usage-warn').hidden;", 'no chip under 95%');
  });

  const two = [
    acc('a', 'Team A', { fiveHour: win(30, at(70)), sevenDay: win(41, at(4500)), paused: false, pausedUntil: null }),
    acc('b', 'Team B', { fiveHour: win(12, at(125)), sevenDay: win(20, at(1800)), paused: true, pausedUntil: null }),
  ];
  flow('an account is switched off in Settings: its ring leaves the toolbar, and with none on the app warns and turns all on again', { settings: { accounts: two } }, async (app) => {
    // One ring for the account that is on, a count for the one that is off.
    await app.until("document.querySelectorAll('#usage .uacct').length === 1", 'one ring');
    assert.equal(await app.evaluate("document.querySelector('#usage .ucount')?.textContent"), '+1');
    await app.click('[data-action="open-settings"]');
    await app.click('[data-action="pane"][data-id="accounts"]');
    await app.until("document.querySelectorAll('.acc-card').length === 2", 'the account cards');
    assert.deepEqual(await app.evaluate("[...document.querySelectorAll('.acc-card')].map((c) => [c.classList.contains('off'), c.querySelector('[data-segc][aria-checked=\"true\"]').dataset.v, c.querySelector('.acc-state')?.textContent ?? ''])"),
      [[false, 'on', ''], [true, 'off', 'Off']]);
    assert.match(await app.evaluate("document.querySelector('.pane[data-pane=\"accounts\"] .scap small').textContent"), /^On 1 \/ 2$/);
    // The switch is a radio group with a name, reached with the keyboard.
    assert.equal(await app.evaluate("document.querySelector('.acc-card [role=radiogroup]').getAttribute('aria-label')"), 'Team A task assignment');
    // Off for an hour: saved with its end, and shown until when.
    await app.click('.acc-card [data-segc="acc-assign-a"][data-v="hour"]');
    await app.until("const s = await window.ide.call('state'); const a = s.accounts.find((x) => x.id === 'a'); return a.paused && !!a.pausedUntil;", 'Team A off for an hour');
    // Every account off: a warning in the toolbar, on the pane and above the chat's composer; no failure.
    await app.until("!!document.querySelector('#usage .uwarn')", 'the toolbar warning');
    assert.equal(await app.evaluate("document.querySelector('#usage .uwarn').textContent"), 'No account on');
    await app.until("!!document.querySelector('.acc-banner[role=alert]')", 'the banner');
    assert.match(await app.evaluate("document.querySelector('.acc-banner').textContent"), /^No account on · 0 waiting/);
    assert.equal(await app.evaluate("document.querySelector('#chat-off').hidden"), false);
    assert.equal(await app.evaluate("!!document.querySelector('#chat-off button[data-v=\"accounts\"] svg use[href=\"#s-person\"]')"), true);
    // Turn all on: both on, saved, and the rings back.
    await app.click('.acc-banner [data-action="acc-resume-all"]');
    await app.until("const s = await window.ide.call('state'); return s.accounts.every((x) => !x.paused);", 'every account on');
    await app.until("!document.querySelector('.acc-banner') && document.querySelector('#chat-off').hidden", 'the warnings gone');
    await app.until("document.querySelectorAll('#usage .uacct').length === 2 && !document.querySelector('#usage .ucount')", 'both rings');
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
  // A row with a pill keeps its branch and path under the header's: the header and the rows share one grid.
  await app.say('@fake task demo Keep the columns\n@@fake wait 60000');
  await app.until("!!document.querySelector('#repo-main .li.repo .r .pill')", 'the running pill on a repository row');
  const xs = await app.evaluate("const x = (el, c) => Math.round(el.querySelector(c).getBoundingClientRect().left); return [document.querySelector('#repo-main .li-cols'), ...document.querySelectorAll('#repo-main .li.repo')].map((el) => [x(el, '.c-br'), x(el, '.c-path')]);");
  assert.deepEqual(xs.slice(1), [xs[0], xs[0]], `columns at ${JSON.stringify(xs)}`);
  // Settings: every check is fine, so the status is one line; the home folder shows both of its ends.
  await app.click('[data-action="open-settings"]');
  await app.click('[data-action="pane"][data-id="general"]');
  await app.until("!!document.querySelector('#pre-rows .ssum')", 'the status on one line');
  assert.match(await app.evaluate("[...document.querySelectorAll('#pre-rows .ssum .pill')].map((p) => p.textContent).join()"), /^All \d OK$/);
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

flow('sleep when done is armed from the toolbar, counts down once no work is left, cancels, and sleeps once', {}, async (app) => {
  const slept = () => app.evaluate("return await window.ide.call('e2e:slept');");
  const pressed = () => app.evaluate("document.getElementById('sleep-btn').getAttribute('aria-pressed')");
  assert.equal(await pressed(), 'false');
  assert.equal(await app.evaluate("document.getElementById('sleep-btn').getAttribute('aria-label')"), 'Sleep when done');
  // Nothing runs: arming starts the countdown at once, and its ✕ turns it off.
  await app.click('#sleep-btn');
  await app.until("!!document.getElementById('sleep-toast')", 'the countdown shown');
  assert.equal(await pressed(), 'true');
  assert.match(await app.evaluate("document.querySelector('#sleep-toast > span').textContent"), /^Sleep in [01]:\d\d$/);
  assert.equal(await app.evaluate("document.querySelector('#sleep-toast .toast-x').getAttribute('aria-label')"), 'Cancel sleep');
  await app.click('#sleep-toast .toast-x');
  await app.until("!document.getElementById('sleep-toast') && document.getElementById('sleep-btn').getAttribute('aria-pressed') === 'false'", 'the countdown cancelled and the toggle off');
  await app.evaluate("return await window.ide.call('e2e:sleepTick', 120000);");
  assert.equal(await slept(), 0);
  // Armed again, a Dispatcher turn holds the countdown; once it ends the countdown runs out and the computer sleeps once.
  await app.click('#sleep-btn');
  await app.say('hello');
  await app.until("return !(await window.ide.call('state')).dispatcher.busy && !!document.getElementById('sleep-toast');", 'the countdown after the turn');
  await app.evaluate("return await window.ide.call('e2e:sleepTick', 61000);");
  await app.until("return await window.ide.call('e2e:slept') === 1;", 'the computer put to sleep');
  await app.until("!document.getElementById('sleep-toast') && document.getElementById('sleep-btn').getAttribute('aria-pressed') === 'false'", 'disarmed after sleeping');
  await app.until("return (await window.ide.call('state')).chat.some((c) => c.kind === 'event' && c.text.includes('put to sleep'));", 'the chat line saying so');
});
