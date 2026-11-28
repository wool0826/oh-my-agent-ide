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

flow('a question reaches the phone with buttons and a press answers it; one answered on the desktop loses its buttons there', { env: { OMA_TELEGRAM_API: tg.url } }, async (app) => {
  await pair(app);
  const asked = (from, n = 1) => tg.state.sent.slice(from).filter((m) => m.reply_markup).slice(n - 1)[0];
  const from = tg.state.sent.length;
  await app.say('@fake task - Pick one\n@@fake ask Which side? | Left | Right\n@@fake result Picked.\n@fake task - Pick again\n@@fake ask Which way? | Up | Down\n@@fake result Went.');
  await waitFor(() => asked(from, 2), 'both questions on the phone with buttons');
  const [q1, q2] = [asked(from, 1), asked(from, 2)];
  const side = /Which side/.test(q1.text) ? q1 : q2;
  const way = side === q1 ? q2 : q1;
  assert.deepEqual(side.reply_markup.inline_keyboard[0].map((b) => b.text), ['Left', 'Right']);

  tg.push(tg.press(42, side.message_id, side.reply_markup.inline_keyboard[0][1].callback_data));
  await app.until("return (await window.ide.call('state')).decisions.some((d) => d.answer === 'Right')", 'the answer in the app');
  await waitFor(() => tg.state.acks.some((a) => a.text === 'Right'), 'the press acknowledged');
  await waitFor(() => tg.state.edits.some((e) => e.message_id === side.message_id && /→ Right$/.test(e.text ?? '')), 'its buttons off on the phone');

  await app.click('#chat-ins .dec [data-action="answer"][data-val="Up"]');
  await waitFor(() => tg.state.edits.some((e) => e.message_id === way.message_id && /→ Up$/.test(e.text ?? '')), 'the desktop answer on the phone');
  // Pressed again after it was answered: already handled.
  tg.push(tg.press(42, way.message_id, way.reply_markup.inline_keyboard[0][1].callback_data));
  await waitFor(() => tg.state.acks.some((a) => a.text === 'Already handled.'), 'already handled');
  assert.ok(!(await app.state()).decisions.some((d) => d.answer === 'Down'));
});

flow('a photo from the phone is saved in the app folder and reaches the Dispatcher with its caption; a program is refused', { env: { OMA_TELEGRAM_API: tg.url } }, async (app) => {
  await pair(app);
  const from = tg.state.sent.length;
  const mine = () => tg.state.sent.slice(from).map((m) => m.text);
  tg.addFile('ph1', 'not really a jpeg', { path: 'photos/file_1.jpg' });
  tg.push(tg.file(42, 'photo', 'ph1', { caption: '@fake say Got the photo.' }));
  await app.until("return (await window.ide.call('state')).chat.some((m) => m.kind === 'user' && m.via === 'telegram')", 'the photo in the chat');
  await waitFor(() => mine().includes('Got the photo.'), 'the answer on the phone');
  // The message names the file, written under <home>/data/telegram in a folder of its own.
  const item = (await app.state()).chat.find((m) => m.kind === 'user' && m.via === 'telegram');
  const file = item.text.match(/\S*[\\/]data[\\/]telegram[\\/]\d{8}-[0-9a-f]{8}[\\/]photo-\d{8}-\d{6}\.jpg/)?.[0];
  assert.ok(file, 'the saved photo in the message');
  assert.equal(fs.readFileSync(file, 'utf8'), 'not really a jpeg');

  tg.addFile('ex1', 'MZ');
  tg.push(tg.file(42, 'document', 'ex1', { name: 'setup.exe' }));
  await waitFor(() => mine().includes('Programs and shortcuts are not received.'), 'the refusal');
  assert.deepEqual(tg.state.downloads, ['photos/file_1.jpg']);
});

flow('a plan reaches the phone with its text and Approve, and a press lets the Worker go on', { env: { OMA_TELEGRAM_API: tg.url } }, async (app) => {
  await pair(app);
  const from = tg.state.sent.length;
  await app.say('@fake task - Plan the change\n@@fake plan WHAT: rename the field\\nHOW: one commit\\nOUTPUT: a PR\n@@fake result Carried out the plan.');
  await waitFor(() => tg.state.sent.slice(from).some((m) => m.reply_markup), 'the plan with buttons');
  const plan = tg.state.sent.slice(from).find((m) => m.reply_markup);
  assert.match(plan.text, /rename the field/);
  const [approve, deny] = plan.reply_markup.inline_keyboard[0];
  assert.deepEqual([approve.text, deny.text], ['Approve plan', 'Deny']);
  tg.push(tg.press(42, plan.message_id, approve.callback_data));
  await waitFor(() => tg.state.sent.slice(from).some((m) => /^W-\d+ done/.test(m.text) && /Plan the change/.test(m.text)), 'the result on the phone');
  assert.ok(tg.state.edits.some((e) => e.message_id === plan.message_id && /→ Approve plan$/.test(e.text ?? '')), 'its buttons off');
});

flow('a message sent while the app was off waits, and Send passes it to the Dispatcher', { env: { OMA_TELEGRAM_API: tg.url } }, async (app) => {
  await pair(app);
  const from = tg.state.sent.length;
  tg.push(tg.user(42, '@fake say Picked up the old one.', { date: Math.floor(Date.now() / 1000) - 3600 }));
  await waitFor(() => tg.state.sent.slice(from).some((m) => m.reply_markup && /waiting/.test(m.text)), 'the question about it');
  assert.ok(!(await app.state()).chat.some((m) => m.kind === 'user' && m.via === 'telegram'), 'it waits');
  const ask = tg.state.sent.slice(from).find((m) => m.reply_markup && /waiting/.test(m.text));
  tg.push(tg.press(42, ask.message_id, ask.reply_markup.inline_keyboard[0][0].callback_data));
  await waitFor(() => tg.state.sent.slice(from).some((m) => m.text === 'Picked up the old one.'), 'the answer on the phone');
});
