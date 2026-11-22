import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoTitle, automationMessage, isDue, nextRun, parseTime } from '../src/shared/automations';

test('a time of day is read loosely and written as HH:MM', () => {
  assert.equal(parseTime('9'), '09:00');
  assert.equal(parseTime(' 9:5 '), '09:05');
  assert.equal(parseTime('18.30'), '18:30');
  assert.equal(parseTime('24:00'), null);
  assert.equal(parseTime('9:60'), null);
  assert.equal(parseTime('morning'), null);
});

test('a daily automation runs today if its time is still ahead, else tomorrow', () => {
  const daily = { kind: 'daily' as const, time: '09:00', weekdays: false };
  // Wednesday 2026-11-18
  assert.deepEqual(nextRun(daily, new Date(2026, 10, 18, 8, 0)), new Date(2026, 10, 18, 9, 0));
  assert.deepEqual(nextRun(daily, new Date(2026, 10, 18, 9, 0)), new Date(2026, 10, 19, 9, 0));
  assert.deepEqual(nextRun(daily, new Date(2026, 10, 18, 23, 59)), new Date(2026, 10, 19, 9, 0));
});

test('on weekdays only, Saturday and Sunday are skipped', () => {
  const wk = { kind: 'daily' as const, time: '09:00', weekdays: true };
  // Friday 2026-11-20 after its time: Monday the 23rd
  assert.deepEqual(nextRun(wk, new Date(2026, 10, 20, 10, 0)), new Date(2026, 10, 23, 9, 0));
  // Saturday morning: still Monday
  assert.deepEqual(nextRun(wk, new Date(2026, 10, 21, 7, 0)), new Date(2026, 10, 23, 9, 0));
});

test('an event trigger has no next run and is never due by the clock', () => {
  assert.equal(nextRun({ kind: 'merged' }, new Date()), null);
  assert.equal(isDue({ enabled: true, trigger: { kind: 'merged' }, nextRunAt: null }, new Date()), false);
});

test('due means switched on and past its time', () => {
  const now = new Date(2026, 10, 18, 9, 0, 30);
  const trigger = { kind: 'daily' as const, time: '09:00', weekdays: false };
  assert.equal(isDue({ enabled: true, trigger, nextRunAt: new Date(2026, 10, 18, 9, 0).toISOString() }, now), true);
  assert.equal(isDue({ enabled: false, trigger, nextRunAt: new Date(2026, 10, 18, 9, 0).toISOString() }, now), false);
  assert.equal(isDue({ enabled: true, trigger, nextRunAt: new Date(2026, 10, 19, 9, 0).toISOString() }, now), false);
});

test('the title is the first line, and the message carries what set it off', () => {
  assert.equal(autoTitle('Check outdated dependencies\nand open one PR'), 'Check outdated dependencies');
  assert.equal(autoTitle('x'.repeat(80)).length, 48);
  assert.equal(automationMessage({ title: 'Deps', prompt: ' Check them. ' }), '[Automation: Deps]\nCheck them.');
  assert.equal(automationMessage({ title: 'Notes', prompt: 'Update the notes.' }, 'PR https://x/pull/1 was merged.'), '[Automation: Notes]\nPR https://x/pull/1 was merged.\nUpdate the notes.');
});
