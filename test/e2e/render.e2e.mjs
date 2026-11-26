// End-to-end flows: the window draws only what changed (decision 214).
import assert from 'node:assert/strict';
import { flow } from './harness.mjs';

const mine = (text) => `[...document.querySelectorAll('#chat-thread .bub.me')].find((b) => b.textContent.includes(${JSON.stringify(text)}))`;
const answered = (text) => `return [...document.querySelectorAll('#chat-thread .bub')].some((b) => b.textContent.includes(${JSON.stringify(text)})) && !(await window.ide.call('state')).dispatcher.busy;`;

flow('a chat message keeps the elements of the messages before it, until the user does something in the thread', {}, async (app) => {
  await app.until("!!document.querySelector('#chat-ins .seg')", 'the app ready');
  await app.say('First message\n@fake say First answered.');
  await app.until(answered('First answered.'), 'the first answer, the Dispatcher idle');
  await app.evaluate(`window.__first = ${mine('First message')}; return !!window.__first;`);

  await app.say('Second message\n@fake say Second answered.');
  await app.until(answered('Second answered.'), 'the second answer, the Dispatcher idle');
  assert.equal(await app.evaluate(`return ${mine('First message')} === window.__first;`), true, 'the first message is the same element');

  // A handler may change the thread's elements by hand: after a click in it the next draw makes them all again.
  await app.click('#chat-thread .bub.me');
  await app.say('Third message\n@fake say Third answered.');
  await app.until(answered('Third answered.'), 'the third answer, the Dispatcher idle');
  assert.equal(await app.evaluate('return window.__first.isConnected;'), false, 'the first message drawn again');
  assert.ok(await app.evaluate(`return !!${mine('First message')};`), 'and still shown');
});

flow('text typed into the composer leaves the other panels as they are; a key anywhere else draws them all at the next update', {}, async (app) => {
  await app.until("!!document.querySelector('#chat-ins .seg')", 'the app ready');
  // A panel written again loses the mark: a write of the same HTML goes through only after the user acted.
  const kept = "document.getElementById('chat-ins').firstElementChild?.dataset.kept === '1'";
  await app.evaluate("document.getElementById('chat-ins').firstElementChild.dataset.kept = '1'; return 1;");
  await app.evaluate("const i = document.getElementById('chat-input'); i.dispatchEvent(new InputEvent('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 1;");
  await app.say('Typed message\n@fake say Typed answered.');
  await app.until(answered('Typed answered.'), 'the answer, the Dispatcher idle');
  assert.equal(await app.evaluate(kept), true, 'the right sidebar kept its elements');

  await app.evaluate("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true })); return 1;");
  await app.say('Another message\n@fake say Another answered.');
  await app.until(answered('Another answered.'), 'the second answer, the Dispatcher idle');
  assert.equal(await app.evaluate(kept), false, 'the right sidebar written again');
});
