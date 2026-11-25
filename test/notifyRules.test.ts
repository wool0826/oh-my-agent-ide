import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Burst, cleanTime, doneNotice, inQuietHours, notifyDoneFrom, quietUntil } from '../src/shared/notifyRules';
import { tr } from '../src/shared/i18n';
import type { Say } from '../src/shared/askWhy';

const at = (h: number, m = 0) => new Date(2026, 10, 22, h, m);

test('quiet hours within a day include the start and not the end', () => {
  assert.equal(inQuietHours('12:00', '13:00', at(12, 0)), true);
  assert.equal(inQuietHours('12:00', '13:00', at(12, 59)), true);
  assert.equal(inQuietHours('12:00', '13:00', at(13, 0)), false);
  assert.equal(inQuietHours('12:00', '13:00', at(11, 59)), false);
});

test('quiet hours can pass midnight', () => {
  assert.equal(inQuietHours('22:00', '07:00', at(23, 30)), true);
  assert.equal(inQuietHours('22:00', '07:00', at(3)), true);
  assert.equal(inQuietHours('22:00', '07:00', at(7)), false);
  assert.equal(inQuietHours('22:00', '07:00', at(12)), false);
});

test('without both times, or with the same time twice, nothing is quiet', () => {
  assert.equal(inQuietHours('', '07:00', at(3)), false);
  assert.equal(inQuietHours('22:00', '', at(23)), false);
  assert.equal(inQuietHours('09:00', '09:00', at(9)), false);
  assert.equal(inQuietHours('late', '7', at(3)), false);
  assert.equal(cleanTime('7'), '07:00');
  assert.equal(cleanTime('25:00'), '');
  assert.equal(cleanTime(7), '');
});

test('a burst from one source shows its first notification only, and other sources are not held back', () => {
  const b = new Burst(20_000);
  assert.equal(b.allow('W-01', 0), true);
  assert.equal(b.allow('W-01', 5_000), false);
  assert.equal(b.allow('W-02', 6_000), true);
  // Still inside the window of the one before: the burst goes on.
  assert.equal(b.allow('W-01', 24_000), false);
  assert.equal(b.allow('W-01', 44_000), true);
});

test('task-end notifications keep what the old switches did, until they are set on their own', () => {
  assert.equal(notifyDoneFrom({}), true);
  assert.equal(notifyDoneFrom({ notifications: true, notifyResults: true }), true);
  // "OS notifications" off used to silence results too; turning decisions back on later does not start them.
  assert.equal(notifyDoneFrom({ notifications: false }), false);
  assert.equal(notifyDoneFrom({ notifications: true, notifyResults: false }), false);
  assert.equal(notifyDoneFrom({ notifications: false, notifyDone: true }), true);
  assert.equal(notifyDoneFrom({ notifications: true, notifyResults: true, notifyDone: false }), false);
});

const say: Say = (k, v) => tr('en', k, v);
const sayKo: Say = (k, v) => tr('ko', k, v);

test('a task-end notification says who, how it ended and its PR, over the title and one line of the result', () => {
  const pr = 'https://github.com/o/r/pull/113';
  assert.deepEqual(doneNotice(say, { who: 'W-02', title: 'Add alerts', summary: 'Added  them.\nTests pass.', ok: true, code: true, prUrl: pr }),
    { title: 'W-02 done · PR #113', body: 'Add alerts\nAdded them. Tests pass.' });
  assert.equal(doneNotice(say, { who: 'W-02', title: 'Fix', summary: 's', ok: true, code: true }).title, 'W-02 done · no PR');
  assert.equal(doneNotice(say, { who: 'W-02', title: 'Research', summary: 's', ok: true, code: false }).title, 'W-02 done');
  assert.equal(doneNotice(say, { who: 'W-02', title: 'Fix', summary: 's', ok: true, label: 'CI fixed', prUrl: pr }).title, 'W-02 CI fixed · PR #113');
  assert.equal(doneNotice(say, { who: 'W-02', title: 'Fix', summary: 'boom', ok: false, code: true }).title, 'W-02 failed');
  assert.equal(doneNotice(sayKo, { who: 'W-02', title: 'Fix', summary: 's', ok: false, prUrl: pr }).title, 'W-02 실패 · PR #113');
  assert.equal(doneNotice(sayKo, { who: 'W-02', title: 'Fix', summary: 's', ok: true, code: true }).title, 'W-02 완료 · PR 없음');
  const long = doneNotice(say, { who: 'W-02', title: 'T', summary: 'x'.repeat(300), ok: true }).body.split('\n')[1];
  assert.equal(long.length, 120);
  assert.ok(long.endsWith('…'));
});

test('while the quiet hours are on, their end is known; outside them there is none', () => {
  const at = (h: number, m: number) => new Date(2026, 10, 25, h, m);
  assert.equal(quietUntil('22:00', '7', at(23, 30)), '07:00');
  assert.equal(quietUntil('22:00', '7', at(6, 59)), '07:00');
  assert.equal(quietUntil('22:00', '7', at(7, 0)), null);
  assert.equal(quietUntil('', '07:00', at(3, 0)), null);
});
