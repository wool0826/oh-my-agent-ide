// End-to-end flows: the in-app update rows in Settings (decision 212). Fake mode never reaches the network:
// OMA_FAKE_UPDATE makes a version count as downloaded and checked.
import assert from 'node:assert/strict';
import { flow } from './harness.mjs';

const task = (state, title) => state.tasks.find((x) => x.title === title);
const DEC = '#chat-ins .dec';
const fakeReady = { settings: { updateCheck: true, maxWorkers: 1 }, env: { OMA_FAKE_UPDATE: '9.9.9' } };

flow('a downloaded update shows in Settings and its restart waits while Workers or queued tasks are working', fakeReady, async (app) => {
  await app.until("document.querySelector('.side-foot [data-action=\"open-settings\"]').classList.contains('has-update')", 'the dot on the gear');
  await app.click('[data-action="open-settings"]');
  await app.click('.snav-i[data-id="general"]');
  await app.until("document.getElementById('upd-st')?.innerText === '9.9.9 ready'", 'the ready row');
  await app.until("/^v\\d+\\.\\d+\\.\\d+$/.test(document.getElementById('set-ver-v').innerText)", 'the running version');
  assert.equal(await app.evaluate("document.getElementById('set-upd').checked"), true);
  assert.equal(await app.evaluate("document.getElementById('upd-apply').disabled"), false);
  assert.equal(await app.evaluate("!!document.getElementById('upd-wait')"), false);
  // Downloaded here, so no "Get" link beside the version.
  assert.equal(await app.evaluate("document.getElementById('ver-upd').innerText"), '');

  // One Worker waits for an answer and the second task is queued behind it (one slot): the restart waits and says for what.
  await app.say('@fake task - First\n@@fake permission npm run one\n@@fake result One.\n@fake task - Second\n@@fake result Two.');
  await app.until(`!!document.querySelector('${DEC}')`, "the first task's permission card");
  assert.equal(task(await app.state(), 'Second').status, 'queued');
  // Settings stayed open: the row follows the work as it changes.
  await app.until("document.getElementById('upd-wait')?.innerText === 'Workers running 1 · Tasks queued 1'", 'what the restart waits for');
  assert.equal(await app.evaluate("document.getElementById('upd-apply').disabled"), true);
  // The main process refuses it too.
  assert.equal(await app.evaluate("return await window.ide.call('update:apply');"), false);

  // With the setting off the rows go.
  await app.click('#set-upd');
  await app.until("!document.getElementById('upd-st')", 'no status row with the setting off');
});
