// End-to-end flows: the Telegram channel in Settings > Notifications, against the stand-in for the Bot API.
// Each flow starts the built app on its own empty profile with fake agents. Run with `npm run e2e`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after } from 'node:test';
import { flow, waitFor } from './harness.mjs';
import { startTelegramStub } from './telegram-stub.mjs';

const tg = await startTelegramStub();
after(() => tg.close());

/** Every file the app wrote under its profile, read as text: none may hold the token. */
function filesHolding(dir, secret) {
  const hits = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue;
    const p = path.join(e.parentPath ?? e.path, e.name);
    try { if (fs.readFileSync(p, 'latin1').includes(secret)) hits.push(p); } catch { /* gone meanwhile */ }
  }
  return hits;
}

flow('Telegram is turned on after a warning, paired by code and confirmed, tested, and shows a revoked token', { env: { OMA_TELEGRAM_API: tg.url } }, async (app) => {
  await app.click('[data-action="open-settings"]');
  await app.click('[data-action="pane"][data-id="alerts"]');
  await app.until("return !!document.getElementById('tg-on')", 'the Telegram switch');
  // The switch waits for the warning; cancelling leaves it off.
  await app.click('#tg-on');
  await app.until("return !!document.querySelector('[data-action=\"tg-warn-yes\"]')", 'the warning');
  await app.click('[data-action="tg-warn-no"]');
  assert.equal(await app.evaluate("return document.getElementById('tg-on').checked + '|' + !!document.getElementById('tg-tok');"), 'false|false');
  await app.click('#tg-on');
  await app.click('[data-action="tg-warn-yes"]');
  await app.until("return document.getElementById('tg-st')?.dataset.tone === 'warning' && !!document.getElementById('tg-tok')", 'the token field');

  // The token goes to the main process once; the field is emptied and a code opens.
  await app.evaluate(`const el = document.getElementById('tg-tok'); el.value = ${JSON.stringify(tg.token)}; el.dispatchEvent(new Event('change', { bubbles: true })); return 1;`);
  await app.until("return document.getElementById('tg-st')?.dataset.tone === 'accent' && !!document.querySelector('code#tg-code')", 'the pairing code');
  assert.equal(await app.evaluate("return document.getElementById('tg-tok').value;"), '');
  const code = (await app.state()).telegram.code;
  assert.match(code, /^[A-Z2-9]{8}$/);
  assert.equal(JSON.stringify(await app.state()).includes(tg.token), false, 'the window never gets the token');
  await app.until(`return !!document.querySelector('[data-action="open-url"][data-href="https://t.me/stub_bot?start=${code}"]')`, 'the bot link');

  // A stranger's message does nothing; the code from the owner shows who sent it, and the desktop confirms.
  tg.push(tg.user(777, 'hi', { name: 'Stranger' }));
  tg.push(tg.user(42, `/start ${code}`, { name: 'Owner' }));
  await app.until("return document.getElementById('tg-cand')?.textContent === 'Owner · 42'", 'the sender to confirm');
  await app.click('[data-action="tg-confirm"]');
  await app.until("return document.getElementById('tg-st')?.dataset.tone === 'success' && document.getElementById('tg-owner')?.textContent === 'Owner · 42'", 'connected');
  assert.deepEqual(tg.state.sent.map((m) => m.chat_id), [42]);

  await app.click('[data-action="tg-test"]');
  await app.until("return document.querySelector('.toast')?.textContent.includes('Test message sent')", 'the test toast');
  assert.equal(tg.state.sent.length, 2);
  assert.match(tg.state.sent[1].text, /Test message/);

  // Narrow window: the group fits without a sideways scroll.
  await app.size(900);
  assert.equal(await app.evaluate("const p = document.querySelector('.pane[data-pane=\"alerts\"]'); return p.scrollWidth <= p.clientWidth;"), true);

  // The token is kept encrypted, and in no file of the profile in plain.
  const saved = JSON.parse(fs.readFileSync(path.join(app.dir, 'data', 'settings.json'), 'utf8'));
  assert.match(saved.telegramTokenEnc, /^enc:/);
  assert.equal(saved.telegram.ownerId, 42);
  assert.deepEqual(filesHolding(app.dir, tg.token), []);

  // Revoked in BotFather: the next send marks it, once, in Settings and the chat.
  tg.revoke();
  await app.click('[data-action="tg-test"]');
  await app.until("return document.getElementById('tg-st')?.dataset.tone === 'danger'", 'the invalid token chip');
  await app.until("return (await window.ide.call('state')).chat.some((m) => m.kind === 'error' && m.text.includes('no longer works'))", 'the chat told');
  assert.deepEqual(filesHolding(app.dir, tg.token), []);
});

flow('once paired, a permission reaches the phone without its command, and the result with its summary', { env: { OMA_TELEGRAM_API: tg.url } }, async (app) => {
  const from = tg.state.sent.length;
  const news = () => tg.state.sent.slice(from + 1).map((m) => m.text);
  await app.evaluate("await window.ide.call('telegram:enable', true); return 1;");
  await app.evaluate(`await window.ide.call('telegram:token', ${JSON.stringify(tg.state.token)}); return 1;`);
  const code = (await app.state()).telegram.code;
  tg.push(tg.user(42, `/start ${code}`, { name: 'Owner' }));
  await app.until("return !!(await window.ide.call('state')).telegram.candidate", 'the sender');
  await app.evaluate("await window.ide.call('telegram:confirm'); return 1;");
  await app.until("return (await window.ide.call('state')).telegram.status === 'connected'", 'connected');

  await app.say(['Write a note', '@fake task - Write a note', '@@fake permission npm install left-pad', '@@fake result Wrote the note.'].join('\n'));
  await app.until("!!document.querySelector('#chat-ins .dec')", 'the permission card');
  await waitFor(() => news().length >= 1, 'the decision on the phone');
  assert.match(news()[0], /^W-\d+ needs your decision$/);
  await app.click('#chat-ins .dec [data-action="answer"][data-val="allow-task"]');
  await waitFor(() => news().some((t) => /done/.test(t)), 'the result on the phone');
  const res = news().find((t) => /done/.test(t));
  assert.match(res, /Write a note/);
  assert.match(res, /Wrote the note\./);
  assert.ok(news().every((t) => !t.includes('left-pad')), 'no command body leaves');
});

/** Turns Telegram on with the stand-in's token and pairs the owner (id 42) through the IPC, as Settings does. */
async function pair(app) {
  await app.evaluate("await window.ide.call('telegram:enable', true); return 1;");
  await app.evaluate(`await window.ide.call('telegram:token', ${JSON.stringify(tg.state.token)}); return 1;`);
  const code = (await app.state()).telegram.code;
  tg.push(tg.user(42, `/start ${code}`, { name: 'Owner' }));
  await app.until("return !!(await window.ide.call('state')).telegram.candidate", 'the sender');
  await app.evaluate("await window.ide.call('telegram:confirm'); return 1;");
  await app.until("return (await window.ide.call('state')).telegram.status === 'connected'", 'connected');
}

flow('from the paired phone, words reach the Dispatcher and its answer comes back; strangers and desktop turns stay off the phone', { env: { OMA_TELEGRAM_API: tg.url } }, async (app) => {
  await pair(app);
  const from = tg.state.sent.length;
  const mine = () => tg.state.sent.slice(from);
  tg.push(tg.user(777, '@fake say I am not the owner', { name: 'Stranger' }));
  tg.push(tg.user(42, '@fake say Gave it to W-01.'));
  await app.until("return (await window.ide.call('state')).chat.some((m) => m.kind === 'user' && m.via === 'telegram')", 'the phone message in the chat');
  await app.until("return !!document.querySelector('.bub.me .bub-via[aria-label=\"From Telegram\"]')", 'the phone mark on it');
  await waitFor(() => mine().some((m) => m.text === 'Gave it to W-01.'), 'the answer on the phone');
  const chat = (await app.state()).chat;
  assert.ok(chat.every((m) => !m.text.includes('not the owner')), 'the stranger reached nothing');
  assert.ok(tg.state.sent.every((m) => m.chat_id === 42), 'nobody but the owner is answered');

  // Written on the desktop: the answer stays there.
  await app.say('@fake say Desktop only.');
  await app.until("return (await window.ide.call('state')).chat.some((m) => m.kind === 'dispatcher' && m.text === 'Desktop only.')", 'the desktop answer');
  tg.push(tg.user(42, '/status'));
  await waitFor(() => mine().some((m) => m.text.startsWith('Dispatcher · ')), 'the status on the phone');
  assert.ok(mine().every((m) => !m.text.includes('Desktop only.')), 'a desktop turn is not sent to the phone');

  // Locked from the phone: words are turned away, and the switch shows off in Settings.
  tg.push(tg.user(42, '/lock'));
  await waitFor(() => mine().some((m) => /^Locked/.test(m.text)), 'the lock answer');
  await app.until("return (await window.ide.call('state')).telegram.prefs.requests === false", 'requests off');
});
