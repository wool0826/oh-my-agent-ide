import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkPrs, checkPrsNow } from '../src/main/prmonitor';

// Nothing is watched, so no gh command runs.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-prrefresh-'));
process.env.OMA_DATA_DIR = tmp;
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ home: path.join(tmp, 'home'), language: 'en', notifications: false, accounts: [] }));

test('prmonitor: "Check PRs now" resolves once its round is over, also when asked during a round', async () => {
  assert.equal(await checkPrsNow(), true);
  const round = checkPrs();
  // Asked while that round runs: it waits for the round that follows.
  const both = await Promise.all([checkPrsNow(), checkPrsNow(), round]);
  assert.deepEqual(both, [true, true, undefined]);
});
