// End-to-end flows: Shell runs: the side terminal, lines run with !, saved scripts, the dock and the side question.
// Each flow starts the built app on its own empty profile with fake agents and a stand-in for gh. Run with `npm run e2e`.
import assert from 'node:assert/strict';
import path from 'node:path';
import { flow } from './harness.mjs';

flow('a saved script shows its command, runs only from its Run button into the chat, and is edited and deleted', {}, async (app) => {
  await app.click('[data-action="ins-tab"][data-v="script"]');
  await app.until("!!document.querySelector('#chat-ins [data-keep=\"script-name-new\"]')", 'the new script form');
  // Saving does not run it: nothing is in the chat until Run.
  await app.evaluate("document.querySelector('#chat-ins [data-keep=\"script-name-new\"]').value = 'Say hello'; const c = document.querySelector('#chat-ins [data-keep=\"script-cmd-new\"]'); c.value = 'echo first-line\\necho saved-script-ok'; c.focus(); return 1;");
  await app.key('Enter', 'Enter', 13);
  await app.until("document.querySelectorAll('#chat-ins .memo.script').length === 1", 'the saved script');
  assert.equal(await app.evaluate("return document.querySelector('#chat-ins .memo.script .script-cmd').innerText;"), 'echo first-line\necho saved-script-ok');
  assert.equal(await app.evaluate("return document.querySelectorAll('#chat-thread .sh-run').length;"), 0);
  assert.equal(await app.evaluate("return document.querySelector('#chat-ins [data-keep=\"script-name-new\"]').value;"), '');
  // Run: its block in the chat, named, with both lines' output.
  await app.click('#chat-ins .memo.script [data-action="script-run"]');
  await app.until("!!document.querySelector('#chat-thread .sh-run:not(.live)')", 'the run ended');
  const block = await app.evaluate("const b = document.querySelector('#chat-thread .sh-run'); return { name: b.querySelector('.sh-name')?.innerText, out: b.querySelector('.sh-out')?.innerText, code: b.querySelector('header code').innerText };");
  assert.equal(block.name, 'Say hello');
  assert.match(block.out, /first-line[\s\S]*saved-script-ok/);
  assert.match(block.code, /^echo first-line \+1 line$/);
  // Edit: the form holds what is saved; Enter in the name saves the change.
  await app.click('#chat-ins .memo.script [data-action="script-edit"]');
  await app.until("document.activeElement?.matches('#chat-ins [data-keep^=\"script-name-\"]:not([data-keep=\"script-name-new\"])')", 'the edit form');
  await app.evaluate("const n = document.activeElement; n.value = 'Say hi'; return 1;");
  await app.key('Enter', 'Enter', 13);
  await app.until("document.querySelector('#chat-ins .memo.script.open p')?.innerText === 'Say hi'", 'the renamed script');
  // Delete asks first.
  await app.click('#chat-ins .memo.script [data-action="script-remove"]');
  assert.equal(await app.evaluate("return document.querySelectorAll('#chat-ins .memo.script').length;"), 1);
  await app.click('#chat-ins .memo.script [data-action="script-remove"]');
  await app.until("!document.querySelector('#chat-ins .memo.script')", 'the script deleted');
});

flow('copy buttons write a saved script, a run with its output and a code block, and show a tick for a while', {}, async (app) => {
  await app.evaluate("window.__copied = []; navigator.clipboard.writeText = async (t) => { window.__copied.push(t); }; return 1;");
  await app.click('[data-action="ins-tab"][data-v="script"]');
  await app.until("!!document.querySelector('#chat-ins [data-keep=\"script-name-new\"]')", 'the new script form');
  await app.evaluate("document.querySelector('#chat-ins [data-keep=\"script-name-new\"]').value = 'Say hello'; document.querySelector('#chat-ins [data-keep=\"script-cmd-new\"]').value = 'echo hello\\necho again'; return 1;");
  await app.click('#chat-ins [data-action="script-save"][data-id="new"]');
  await app.until("document.querySelectorAll('#chat-ins .memo.script').length === 1", 'the saved script');
  // The script: its whole command, then a tick on an icon-only button that says so.
  await app.evaluate("document.querySelector('#chat-ins .memo.script [data-action=\"script-copy\"]').click(); return 1;");
  await app.until("window.__copied.length === 1", 'the script copied');
  assert.equal(await app.evaluate('return window.__copied[0];'), 'echo hello\necho again');
  await app.until("document.querySelector('#chat-ins [data-action=\"script-copy\"]')?.matches('.copied')", 'the copied tick');
  const btn = await app.evaluate("const b = document.querySelector('#chat-ins [data-action=\"script-copy\"]'); return { use: b.querySelector('use').getAttribute('href'), label: b.getAttribute('aria-label'), text: b.innerText.trim() };");
  assert.equal(btn.use, '#s-tick');
  assert.equal(btn.label, 'Copied');
  assert.equal(btn.text, '');
  await app.until("!document.querySelector('#chat-ins [data-action=\"script-copy\"]').matches('.copied') && document.querySelector('#chat-ins [data-action=\"script-copy\"] use').getAttribute('href') === '#s-copy'", 'the copy icon back');
  // A finished run: its command and its output.
  await app.click('#chat-ins .memo.script [data-action="script-run"]');
  await app.until("!!document.querySelector('#chat-thread .sh-run:not(.live) [data-action=\"shell-copy\"]')", 'the finished run');
  await app.click('#chat-thread .sh-run [data-action="shell-copy"]');
  await app.until("window.__copied.length === 2", 'the run copied');
  assert.match(await app.evaluate('return window.__copied[1];'), /^\$ echo hello[\s\S]*hello[\s\S]*again/);
  // A code block in a reply: only its code.
  await app.say('@fake say Check: ```sh gh pr checks 212 --watch```');
  await app.until("!!document.querySelector('#chat-thread .code [data-action=\"code-copy\"]')", 'the code block bar');
  await app.evaluate("document.querySelector('#chat-thread .code [data-action=\"code-copy\"]').click(); return 1;");
  await app.until("window.__copied.length === 3", 'the code copied');
  assert.equal(await app.evaluate('return window.__copied[2].trim();'), 'gh pr checks 212 --watch');
  // Refused by the clipboard: the code is selected instead.
  await app.evaluate("navigator.clipboard.writeText = () => Promise.reject(new Error('denied')); document.execCommand = () => false; document.querySelector('#chat-thread .code [data-action=\"code-copy\"]').click(); return 1;");
  await app.until("String(getSelection()).trim() === 'gh pr checks 212 --watch'", 'the code selected');
});

flow('the side terminal runs lines apart from the chat in the dock under it, recalls them with the up arrow, folds stderr and clears', {}, async (app) => {
  // Ctrl+` opens it with its input focused, in the dock between the chat and the composer.
  await app.key('Backquote', '`', 192, 2);
  await app.until("!document.querySelector('#tm').hidden && document.activeElement?.id === 'tm-input'", 'the open terminal');
  assert.equal(await app.evaluate("return document.querySelector('#dock-tab-tm').getAttribute('aria-selected');"), 'true');
  // The dock covers nothing: the chat ends above it, and it ends above the composer.
  const layout = await app.evaluate("const r = (s) => document.querySelector(s).getBoundingClientRect(); return { chat: r('#chat-thread').bottom, top: r('#dock').top, bottom: r('#dock').bottom, composer: r('#chat-form').top };");
  assert.ok(layout.chat <= layout.top + 0.5, `the chat ends above the dock: ${JSON.stringify(layout)}`);
  assert.ok(layout.bottom <= layout.composer, `the dock ends above the composer: ${JSON.stringify(layout)}`);
  // "in <folder>" is one run of text (no gap before the words after the folder).
  assert.equal(await app.evaluate("return document.querySelectorAll('#tm-cwd > .sh-cwd-t').length;"), 1);
  await app.evaluate("document.querySelector('#tm-input').value = 'echo side-terminal-ok'; return 1;");
  await app.key('Enter', 'Enter', 13);
  // A real shell starts and ends each line: the wait is for the finished run, as long as a slow runner takes, and a
  // failure shows what the terminal holds.
  const TM = "(document.querySelector('#tm')?.innerText ?? 'no terminal').slice(-1500)";
  await app.until("[...document.querySelectorAll('#tm-thread .tm-run:not(.live) .tm-out')].some((o) => o.innerText.includes('side-terminal-ok'))", 'the finished run with its output in the terminal', 60_000, TM);
  // Not in the chat.
  assert.equal(await app.evaluate("return document.querySelectorAll('#chat-thread .sh-run').length;"), 0);
  assert.equal(await app.evaluate("return document.querySelector('#tm-input').value;"), '');
  // ↑ brings the line back.
  await app.key('ArrowUp', 'ArrowUp', 38);
  assert.equal(await app.evaluate("return document.querySelector('#tm-input').value;"), 'echo side-terminal-ok');
  // stderr in the danger colour, folded to its first line; "+2 lines" opens the rest.
  await app.evaluate(`document.querySelector('#tm-input').value = ${JSON.stringify(`node -e "console.error('bad one');console.error('bad two');console.error('bad three')"`)}; return 1;`);
  await app.key('Enter', 'Enter', 13);
  const errRun = "[...document.querySelectorAll('#tm-thread .tm-run:not(.live)')].find((r) => r.innerText.includes('bad one'))";
  await app.until(`!!${errRun}`, 'the finished run that wrote to stderr', 60_000, TM);
  await app.until(`!!${errRun}?.querySelector('.o-more')`, 'its stderr folded', 5000, TM);
  assert.deepEqual(await app.evaluate(`const r = ${errRun}; return [r.querySelector('.o-err').textContent, r.querySelector('.o-more').textContent];`), ['bad one', '+2 lines']);
  await app.evaluate(`${errRun}.querySelector('.o-more').click(); return 1;`);
  await app.until(`${errRun}?.querySelector('.o-err')?.textContent === 'bad one\\nbad two\\nbad three'`, 'the stderr opened');
  assert.equal(await app.evaluate(`return ${errRun}.querySelector('.o-more').textContent;`), 'Show less');
  // Clear empties it; Esc puts the dock away and the chat input has the focus.
  await app.click('[data-action="tm-clear"]');
  await app.until("!document.querySelector('#tm-thread .tm-run')", 'the cleared terminal');
  await app.key('Escape', 'Escape', 27);
  await app.until("document.querySelector('#dock').hidden && document.activeElement?.id === 'chat-input'", 'the dock put away');
  assert.equal(await app.evaluate("return document.querySelector('#chat-thread').parentElement.classList.contains('dock-open');"), false);
});

flow('a side question is asked and answered in its own panel, and reaches the Dispatcher only when sent over', {}, async (app) => {
  const before = await app.state();
  // Ctrl+J from the chat opens the panel with its input focused.
  await app.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyJ', key: 'j', ctrlKey: true, bubbles: true, cancelable: true })); return 1;");
  await app.until("!document.querySelector('#sq').hidden && document.activeElement?.id === 'sq-input'", 'the side question panel, focused');
  await app.evaluate("const i = document.querySelector('#sq-input'); i.value = 'What is 2 + 2?\\n@fake tokens 2000\\n@fake say It is 4.'; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#sq-form').requestSubmit(); return 1;");
  await app.until("document.querySelector('#sq-thread .bub.wk')?.innerText.includes('It is 4.')", 'the answer in the panel');
  await app.until("document.querySelector('#sq-ctx').innerText.includes('2K')", 'its own context meter');
  // The Dispatcher heard nothing: its chat and its context are as they were.
  const after = await app.state();
  assert.equal(after.chat.length, before.chat.length);
  assert.equal(after.dispatcher.contextTokens, before.dispatcher.contextTokens);
  assert.equal(await app.evaluate("document.querySelector('#chat-thread').innerText.includes('It is 4.')"), false);
  // "Send to the Dispatcher": the answer as a quote chip on the main composer; the panel goes behind its button.
  await app.click('#sq [data-action="sq-to-dispatcher"]');
  await app.until("!document.querySelector('#chat-reply').hidden && document.querySelector('#sq').hidden", 'the chip, and the panel minimised');
  const chip = await app.evaluate("const c = document.querySelector('#chat-reply'); return { who: c.querySelector('b').textContent, quote: c.querySelector('span').textContent, count: document.querySelector('#chat-sq i')?.textContent ?? '' };");
  assert.deepEqual(chip, { who: 'From a side question', quote: 'It is 4.', count: '2' });
  // Close forgets the thread. In a narrow window the header's chip gives way, so Close is whole and clear of the hide button.
  await app.click('#chat-sq');
  await app.size(507, 427);
  await app.until("!document.querySelector('#dock').hidden && !!document.querySelector('#dock [data-action=\"sq-close\"]')?.offsetParent", 'the side question open in the narrow window');
  assert.deepEqual(await app.evaluate(`const c = document.querySelector('#dock [data-action="sq-close"]').getBoundingClientRect(), h = document.querySelector('#dock-hide').getBoundingClientRect(), d = document.querySelector('#dock .dock-h');
    return { clear: c.right <= h.left, fits: d.scrollWidth <= d.clientWidth };`), { clear: true, fits: true });
  await app.size(1320, 860);
  await app.click('#dock [data-action="sq-close"]');
  await app.until("document.querySelector('#dock').hidden && !document.querySelector('#chat-sq i')", 'the thread forgotten');
});

flow('the dock holds the terminal and the side question as tabs, is resized from its top edge and keeps its height', {}, async (app) => {
  await app.size(1400, 900);
  await app.click('#chat-sq');
  await app.until("!document.querySelector('#sq').hidden && document.querySelector('#tm').hidden", 'the side question tab');
  // One dock: the terminal is the other tab, never a second panel; ← → move between the tabs.
  await app.evaluate("document.querySelector('#dock-tab-sq').focus(); return 1;");
  await app.key('ArrowLeft', 'ArrowLeft', 37);
  await app.until("!document.querySelector('#tm').hidden && document.querySelector('#sq').hidden && document.activeElement?.id === 'dock-tab-tm'", 'the terminal tab');
  assert.equal(await app.evaluate("return [document.querySelector('#chat-tm').getAttribute('aria-pressed'), document.querySelector('#chat-sq').getAttribute('aria-pressed')].join();"), 'true,false');
  const h = () => app.evaluate("return document.querySelector('#dock').offsetHeight;");
  const h0 = await h();
  // ↑ ↓ on the top edge's handle, Shift by four steps; the value is said.
  await app.evaluate("document.querySelector('#dock-rz').focus(); return 1;");
  await app.key('ArrowUp', 'ArrowUp', 38, 8);
  await app.key('ArrowDown', 'ArrowDown', 40);
  assert.equal(await h(), h0 + 64 - 16);
  assert.equal(await app.evaluate("return document.querySelector('#dock-rz').getAttribute('aria-valuenow');"), String(h0 + 48));
  // Dragging the capsule up makes it taller; the capsule is marked while it moves, and the chat gets shorter.
  const chat0 = await app.evaluate("return document.querySelector('#chat-thread').offsetHeight;");
  const top = await app.evaluate("const r = document.querySelector('#dock-rz').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 3 };");
  await app.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: top.x, y: top.y, button: 'left', buttons: 1, clickCount: 1 });
  await app.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: top.x, y: top.y - 40, button: 'left', buttons: 1 });
  assert.equal(await app.evaluate("return document.querySelector('#dock-rz').classList.contains('active');"), true);
  await app.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: top.x, y: top.y - 40, button: 'left', buttons: 0, clickCount: 1 });
  assert.equal(await h(), h0 + 88);
  assert.equal(await app.evaluate("return document.querySelector('#chat-thread').offsetHeight;"), chat0 - 40);
  assert.equal(await app.evaluate("localStorage.getItem('oma.dockH')"), String(h0 + 88));
  // Put away and opened again, it keeps its height; a double-click goes back to the first one.
  await app.click('#dock-hide');
  await app.until("document.querySelector('#dock').hidden", 'the dock put away');
  await app.click('#chat-tm');
  await app.until("!document.querySelector('#dock').hidden", 'the dock again');
  assert.equal(await h(), h0 + 88);
  await app.evaluate("document.querySelector('#dock-rz').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return 1;");
  assert.equal(await h(), h0);
});

flow('a line run with ! shows its output in the chat; with the reply chip off, the Dispatcher gets it with its next turn', {}, async (app) => {
  const typeIn = (value) => app.evaluate(`const i = document.querySelector('#chat-input'); i.focus(); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input', { bubbles: true })); return 1;`);
  const shellMode = () => app.evaluate("document.querySelector('#chat-form').classList.contains('shell')");
  // "!" first: shell mode, and the "!" leaves the text. Esc goes back to a message.
  await typeIn('!');
  assert.equal(await shellMode(), true);
  assert.equal(await app.evaluate("document.querySelector('#chat-input').value"), '');
  await app.evaluate("document.querySelector('#chat-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); return 1;");
  assert.equal(await shellMode(), false);

  await typeIn('!node -e "console.log(41 + 1)"');
  assert.equal(await shellMode(), true);
  // A plain line keeps the neutral command line with its warn ring; one that is hard to undo turns it red and says so.
  const risky = () => app.evaluate("return [document.querySelector('#chat-form').classList.contains('risky'), !document.querySelector('#chat-shbar .sh-risk').hidden].join();");
  assert.equal(await risky(), 'false,false');
  await typeIn('git push --force origin main');
  assert.equal(await risky(), 'true,true');
  await typeIn('node -e "console.log(41 + 1)"');
  assert.equal(await risky(), 'false,false');
  // The chip on the bar: on by default; off, the result waits for the next message, and the setting is saved.
  assert.equal(await app.evaluate("document.querySelector('#chat-shbar .sh-ask').getAttribute('aria-pressed')"), 'true');
  await app.click('#chat-shbar .sh-ask');
  assert.equal(await app.evaluate("document.querySelector('#chat-shbar .sh-ask').getAttribute('aria-pressed')"), 'false');
  await app.until("return (await window.ide.call('state')).settings.shellAsk === false;", 'the setting saved');
  await app.evaluate("document.querySelector('#chat-form').requestSubmit(); return 1;");
  await app.until("document.querySelector('#chat-thread .sh-run')?.innerText.includes('Exit 0')", 'the run block with Exit 0');
  const block = await app.evaluate("const b = document.querySelector('#chat-thread .sh-run'); return { cmd: b.querySelector('code').textContent, out: b.querySelector('.sh-out')?.textContent ?? '', dlv: b.querySelector('.sh-dlv').className, said: b.querySelector('.sh-dlv').textContent };");
  assert.equal(block.cmd, 'node -e "console.log(41 + 1)"');
  assert.match(block.out, /42/);
  assert.match(block.dlv, /wait/, 'waits for the Dispatcher');
  assert.equal(block.said, "Waiting for the Dispatcher's turn");
  assert.equal(await shellMode(), false, 'a run leaves shell mode');

  // No turn of its own: it goes with the next message.
  await app.say('What did it print?\n@fake echo [Shell run]');
  await app.until("[...document.querySelectorAll('#chat-thread .bub.ai')].some((b) => b.innerText.includes('[Shell run] The user ran'))", 'the run in what the Dispatcher received');
  await app.until("!!document.querySelector('#chat-thread .sh-run .sh-dlv.ok')", '"The Dispatcher has it"');
  const said = await app.evaluate("[...document.querySelectorAll('#chat-thread .bub.ai')].map((b) => b.innerText).join('\\n')");
  // The bubble draws the command's backticks as code.
  assert.match(said, /\[Shell run\] The user ran node -e "console\.log\(41 \+ 1\)" in the IDE home: exit 0/);
});

flow('a line run with ! shows its stderr in the danger colour, folded to its first line', {}, async (app) => {
  await app.evaluate(`const i = document.querySelector('#chat-input'); i.focus(); i.value = ${JSON.stringify(`!node -e "console.log('fine');console.error('bad one');console.error('bad two')"`)}; i.dispatchEvent(new Event('input', { bubbles: true })); return 1;`);
  await app.evaluate("document.querySelector('#chat-form').requestSubmit(); return 1;");
  await app.until("!!document.querySelector('#chat-thread .sh-run:not(.live) .o-more')", 'the run with its stderr folded');
  const out = await app.evaluate("const b = document.querySelector('#chat-thread .sh-run'); return { err: b.querySelector('.o-err').textContent, more: b.querySelector('.o-more').textContent, plain: [...b.querySelectorAll('.o-seg:not(.o-err)')].map((x) => x.textContent).join('|'), red: getComputedStyle(b.querySelector('.o-err')).color !== getComputedStyle(b.querySelector('.sh-out')).color };");
  assert.deepEqual(out, { err: 'bad one', more: '+1 line', plain: 'fine', red: true });
  await app.click('#chat-thread .sh-run .o-more');
  await app.until("document.querySelector('#chat-thread .sh-run .o-err')?.textContent === 'bad one\\nbad two'", 'the stderr opened');
  assert.equal(await app.evaluate("document.querySelector('#chat-thread .sh-run .o-more').getAttribute('aria-expanded')"), 'true');
});

flow('a line run with ! hands its result to the Dispatcher, which replies without being asked', {}, async (app) => {
  const line = `!node -e "console.log('@fake echo handed you')"`;
  await app.evaluate(`const i = document.querySelector('#chat-input'); i.focus(); i.value = ${JSON.stringify(line)}; i.dispatchEvent(new Event('input', { bubbles: true })); return 1;`);
  assert.equal(await app.evaluate("document.querySelector('#chat-shbar .sh-ask').getAttribute('aria-pressed')"), 'true');
  await app.evaluate("document.querySelector('#chat-form').requestSubmit(); return 1;");
  // The Dispatcher's turn starts by itself, with the run's result and what to do with it.
  await app.until("[...document.querySelectorAll('#chat-thread .bub.ai')].some((b) => b.innerText.includes('handed you its result'))", "the Dispatcher's turn for the run");
  await app.until("!!document.querySelector('#chat-thread .sh-run .sh-dlv.ok')", '"The Dispatcher has it"');
  const st = await app.state();
  assert.equal(st.chat.filter((c) => c.kind === 'user').length, 0, 'the user typed nothing');
  assert.equal(st.chat.find((c) => c.kind === 'shell')?.shell?.ask, true);
  // One turn, not more: the Dispatcher cannot run "!" itself, so nothing starts another.
  // eslint-disable-next-line no-restricted-syntax -- checks that no second turn starts: a while for one that must not come.
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(await app.evaluate("document.querySelectorAll('#chat-thread .bub.ai').length"), 1);
});

// The real terminal's shells (main/pty.ts), driven over its channels as the window will: a real shell of the system
// in a pseudo terminal. Each line prints its mark as two pieces joined, so the echo of what was typed never matches.
// Runs in the page: keeps each tab's output, says it was drawn, and reads it without the terminal's codes.
function ptySetup() {
  if (window.__pty) return;
  window.__pty = {};
  // eslint-disable-next-line no-control-regex -- a terminal's codes start with ESC and BEL
  const plain = (s) => s.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?<>=!]*[ -/]*[@-~]/g, '').replace(/\x1b[()][0-9A-Za-z]/g, '').replace(/\x1b[=>78DEHMc]/g, '').replace(/\r/g, '');
  window.__ptyText = (id) => plain(window.__pty[id] ?? '');
  window.ide.onPtyData((id, d) => { window.__pty[id] = (window.__pty[id] ?? '') + d; window.ide.ptySend('drawn', id, d.length); });
}
const PTY_SETUP = `(${ptySetup})(); return 1;`;

flow('the real terminal keeps one shell: a prompt waits for what is typed, cd carries over, Ctrl+C stops a command, the size follows and Stop ends it', {}, async (app) => {
  const win = process.platform === 'win32';
  await app.evaluate(PTY_SETUP);
  const tab = await app.evaluate("return ide.call('pty:open', { cols: 200, rows: 30 });");
  assert.equal(tab.live, true);
  assert.equal(tab.repo, '');
  assert.equal(tab.name, (await app.evaluate("return ide.call('pty:shells');"))[0].name, 'the default shell');
  const id = JSON.stringify(tab.id);
  const type = (line) => app.evaluate(`ide.ptySend('write', ${id}, ${JSON.stringify(line)}); return 1;`);
  const seen = (text, what, ms = 60_000) => app.until(`window.__ptyText(${id}).includes(${JSON.stringify(text)})`, what, ms, `window.__ptyText(${id}).slice(-1500)`);
  // A shell starts as slowly as a runner makes it (PowerShell with its profile).
  await type(win ? "Write-Output ('pty' + '-ok')\r" : "printf 'pty-%s\\n' ok\r");
  await seen('pty-ok', 'the output of the first line');
  // A prompt waits for what is typed next.
  await type(win ? "$a = Read-Host 'name?'; Write-Output ('got-' + $a)\r" : "printf 'na%s' 'me?> '; read -r a; printf 'got-%s\\n' \"$a\"\r");
  await seen(win ? 'name?: ' : 'name?> ', 'the prompt');
  await type('abc\r');
  await seen('got-abc', 'the answer read by the line');
  // cd carries over to the next line.
  const cwd = win ? "Write-Output ('cw' + 'd=' + (Get-Location).Path + '|')\r" : "printf 'cw%s=%s|\\n' d \"$PWD\"\r";
  await type(cwd);
  await seen('|', 'the folder');
  const where = async () => [...(await app.evaluate(`return window.__ptyText(${id});`)).matchAll(/cwd=([^|\n]+)\|/g)].map((m) => m[1].trim());
  await app.until(`/cwd=[^|\\n]+\\|/.test(window.__ptyText(${id}))`, 'the folder printed');
  const [home] = await where();
  await type('cd ..\r');
  await type(cwd);
  await app.until(`(window.__ptyText(${id}).match(/cwd=[^|\\n]+\\|/g) ?? []).length >= 2`, 'the folder printed again', 30_000, `window.__ptyText(${id}).slice(-1500)`);
  const after = (await where())[1];
  assert.equal(after, (win ? path.win32 : path.posix).dirname(home), `cd .. carried over: ${home} → ${after}`);
  // Ctrl+C stops what runs, long before its 30 s.
  await type(win ? "Write-Output ('zz-' + 'started'); Start-Sleep -Seconds 30\r" : "printf 'zz-%s\\n' started; sleep 30\r");
  await seen('zz-started', 'the long command started');
  await type('\x03');
  // Ctrl+C also drops what was typed ahead (on Windows): the next line is typed again until the prompt takes it.
  for (const end = Date.now() + 20_000; ;) {
    await type(win ? "Write-Output ('after' + '-ctrlc')\r" : "printf 'after-%s\\n' ctrlc\r");
    try { await seen('after-ctrlc', 'the next line, once Ctrl+C stopped the long one', 2500); break; } catch (e) { if (Date.now() > end) throw e; }
  }
  // The size follows.
  await app.evaluate(`ide.ptySend('resize', ${id}, 100, 30); return 1;`);
  await type(win ? "Write-Output ('w=' + $Host.UI.RawUI.WindowSize.Width + '|')\r" : "printf 'sz=%s|\\n' \"$(stty size)\"\r");
  await seen(win ? 'w=100|' : 'sz=30 100|', 'the new size');
  // Nothing of it reached the chat.
  assert.equal(await app.evaluate("return document.querySelectorAll('#chat-thread .sh-run').length;"), 0);
  // Stop ends the shell; the tab stays until it is closed.
  await app.evaluate(`return ide.call('pty:kill', ${id});`);
  await app.until(`ide.call('pty:state').then((v) => v.tabs.length === 1 && !v.tabs[0].live)`, 'the stopped tab', 15_000);
  await app.evaluate(`return ide.call('pty:close', ${id});`);
  assert.deepEqual((await app.evaluate("return ide.call('pty:state');")).tabs, []);
});

flow('with the real terminal off, a tab does not open and the terminal keeps its line mode', { env: { OMA_PTY: '0' } }, async (app) => {
  await assert.rejects(app.evaluate("return ide.call('pty:open');"), /could not start a shell/);
  const v = await app.evaluate("return ide.call('pty:state');");
  assert.equal(v.available, false);
  assert.deepEqual(v.tabs, []);
});
