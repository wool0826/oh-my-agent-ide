import { test } from 'node:test';
import assert from 'node:assert/strict';
import { atLimit, autoTitle, choiceOf, clampPerDay, countRun, editedAutomation, eventContext, eventWatches, freshEvents, automationMessage, isDue, matchesEvent, nextRun, normalizeTrigger, parseEvents, parseTime, runsToday, SEEN_MAX, watchArgs, type AutoEvent } from '../src/shared/automations';
import type { Automation } from '../src/shared/types';

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

const base: Automation = {
  id: 'a1', title: 'Check the build', prompt: 'Check the build\nand say what broke', trigger: { kind: 'daily', time: '09:00', weekdays: true },
  enabled: false, lastRunAt: '2026-11-24T00:00:00.000Z', lastRunChatId: 'c1', nextRunAt: '2026-11-25T00:00:00.000Z', createdAt: '2026-11-01T00:00:00.000Z',
};

test('an edited automation keeps its switch and its last run, and its name follows the text', () => {
  const now = new Date(2026, 10, 25, 8, 0);
  const e = editedAutomation(base, '  Check the tests\nand the lint  ', { kind: 'daily', time: '09:00', weekdays: true }, now);
  assert.equal(e.prompt, 'Check the tests\nand the lint');
  assert.equal(e.title, 'Check the tests');
  assert.deepEqual([e.id, e.enabled, e.lastRunAt, e.lastRunChatId, e.createdAt], [base.id, false, base.lastRunAt, 'c1', base.createdAt]);
  // The same time: the run already worked out stays, so saving does not skip or repeat one.
  assert.equal(e.nextRunAt, base.nextRunAt);
  // An older one stored without the weekdays switch is the same as one with it off.
  const old = { ...base, trigger: { kind: 'daily', time: '09:00' } } as unknown as Automation;
  assert.equal(editedAutomation(old, base.prompt, { kind: 'daily', time: '09:00', weekdays: false }, now).nextRunAt, base.nextRunAt);
});

test('a name given by hand stays when the text changes', () => {
  const named = { ...base, title: 'Morning check' };
  assert.equal(editedAutomation(named, 'Something else', named.trigger, new Date()).title, 'Morning check');
});

test('a changed trigger works out the next run again', () => {
  const now = new Date(2026, 10, 25, 8, 0);
  const later = editedAutomation(base, base.prompt, { kind: 'daily', time: '10:30', weekdays: true }, now);
  assert.equal(later.nextRunAt, new Date(2026, 10, 25, 10, 30).toISOString());
  const everyDay = editedAutomation(base, base.prompt, { kind: 'daily', time: '09:00', weekdays: false }, now);
  assert.equal(everyDay.nextRunAt, new Date(2026, 10, 25, 9, 0).toISOString());
  const merged = editedAutomation(base, base.prompt, { kind: 'merged' }, now);
  assert.deepEqual([merged.trigger, merged.nextRunAt], [{ kind: 'merged' }, null]);
  const back = editedAutomation(merged, base.prompt, { kind: 'daily', time: '07:00', weekdays: false }, now);
  assert.equal(back.nextRunAt, new Date(2026, 10, 26, 7, 0).toISOString());
});

test('a weekly automation runs on its weekday at its time, a week on once that has passed', () => {
  const mon9 = { kind: 'weekly' as const, time: '09:00', day: 1 };
  // 2026-11-25 is a Wednesday.
  assert.equal(nextRun(mon9, new Date(2026, 10, 25, 12, 0))!.toString(), new Date(2026, 10, 30, 9, 0).toString());
  assert.equal(nextRun(mon9, new Date(2026, 10, 30, 8, 0))!.toString(), new Date(2026, 10, 30, 9, 0).toString());
  assert.equal(nextRun(mon9, new Date(2026, 10, 30, 9, 0))!.toString(), new Date(2026, 11, 7, 9, 0).toString());
});

test('every N hours runs N hours after the last time', () => {
  const at = new Date(2026, 10, 25, 10, 30);
  assert.equal(nextRun({ kind: 'every', hours: 6 }, at)!.getTime(), at.getTime() + 6 * 3_600_000);
});

test('a trigger is cleaned up, and a wrong field says which', () => {
  assert.deepEqual(normalizeTrigger({ kind: 'weekly', time: '9', day: 3 }), { kind: 'weekly', time: '09:00', day: 3 });
  assert.deepEqual(normalizeTrigger({ kind: 'weekly', time: '9', day: 7 }), { error: 'badDay' });
  assert.deepEqual(normalizeTrigger({ kind: 'every', hours: 0 }), { error: 'badHours' });
  assert.deepEqual(normalizeTrigger({ kind: 'every', hours: 25 }), { error: 'badHours' });
  assert.deepEqual(normalizeTrigger({ kind: 'issueLabel', label: '  ' }), { error: 'badLabel' });
  assert.deepEqual(normalizeTrigger({ kind: 'ciFailed', repo: ' demo ', branch: ' main ' }), { kind: 'ciFailed', repo: 'demo', branch: 'main' });
  assert.deepEqual(normalizeTrigger({ kind: 'reviewRequested', repo: '', branch: 'x' }), { kind: 'reviewRequested', repo: undefined });
  assert.deepEqual(normalizeTrigger({ kind: 'merged' }), { kind: 'merged' });
  assert.deepEqual(normalizeTrigger({ kind: 'hourly' } as never), { error: 'badKind' });
});

test('the menu choice of a trigger tells daily from weekdays', () => {
  assert.equal(choiceOf({ kind: 'daily', time: '09:00', weekdays: true }), 'weekdays');
  assert.equal(choiceOf({ kind: 'daily', time: '09:00', weekdays: false }), 'daily');
  assert.equal(choiceOf({ kind: 'ciFailed' }), 'ciFailed');
});

test('a limit a day is 1 to 24, or none', () => {
  assert.equal(clampPerDay(3), 3);
  assert.equal(clampPerDay('5'), 5);
  assert.equal(clampPerDay(99), 24);
  assert.equal(clampPerDay(0), null);
  assert.equal(clampPerDay(''), null);
  assert.equal(clampPerDay(null), null);
});

test('runs are counted per local day, and the limit is reached at the count', () => {
  const now = new Date(2026, 10, 25, 12, 0);
  let a: { runs?: { day: string; n: number }; maxPerDay: number | null } = { maxPerDay: 2 };
  a = { ...a, runs: countRun(a, now) };
  assert.equal(runsToday(a, now), 1);
  assert.equal(atLimit(a, now), false);
  a = { ...a, runs: countRun(a, now) };
  assert.equal(atLimit(a, now), true);
  const tomorrow = new Date(2026, 10, 26, 0, 1);
  assert.equal(runsToday(a, tomorrow), 0);
  assert.equal(atLimit(a, tomorrow), false);
  assert.equal(atLimit({ ...a, maxPerDay: null }, now), false);
});

const ev = (over: Partial<AutoEvent> = {}): AutoEvent => ({ kind: 'ciFailed', repo: 'demo', id: '1', branch: 'main', ...over });

test('an event sets off a trigger of its kind, in the repository and branch it names', () => {
  assert.equal(matchesEvent({ kind: 'ciFailed' }, ev()), true);
  assert.equal(matchesEvent({ kind: 'ciFailed', repo: 'demo', branch: 'main' }, ev()), true);
  assert.equal(matchesEvent({ kind: 'ciFailed', repo: 'other' }, ev()), false);
  assert.equal(matchesEvent({ kind: 'ciFailed', branch: 'dev' }, ev()), false);
  assert.equal(matchesEvent({ kind: 'prOpened' }, ev()), false);
  assert.equal(matchesEvent({ kind: 'daily', time: '09:00', weekdays: false }, ev()), false);
});

test('an issue sets off a label trigger only with that label, in any case', () => {
  const issue = ev({ kind: 'issueLabel', labels: ['Bug', 'ui'] });
  assert.equal(matchesEvent({ kind: 'issueLabel', label: 'bug' }, issue), true);
  assert.equal(matchesEvent({ kind: 'issueLabel', label: 'docs' }, issue), false);
});

test('the Dispatcher is told what set an automation off', () => {
  const s = eventContext(ev({ url: 'https://github.com/o/demo/actions/runs/1', title: 'Add tax' }));
  assert.match(s, /CI failed: https:\/\/github\.com\/o\/demo\/actions\/runs\/1 \("Add tax"\) \(repository demo, branch main\)/);
  assert.match(eventContext(ev({ kind: 'issueLabel', branch: undefined, labels: ['bug'] })), /has the label bug \(repository demo\)/);
});

test('each event kind is watched once per repository; no repository means every one', () => {
  const on = (trigger: Automation['trigger']) => ({ enabled: true, trigger });
  const w = eventWatches([
    on({ kind: 'ciFailed', repo: 'demo' }), on({ kind: 'ciFailed', repo: 'demo', branch: 'dev' }), on({ kind: 'prOpened' }),
    on({ kind: 'merged' }), on({ kind: 'issueLabel', repo: 'demo', label: 'bug' }), on({ kind: 'reviewRequested', repo: 'gone' }),
    { enabled: false, trigger: { kind: 'reviewRequested' } }, on({ kind: 'daily', time: '09:00', weekdays: false }),
  ], ['demo', 'web']);
  assert.deepEqual(w, [
    { kind: 'ciFailed', repo: 'demo' }, { kind: 'prOpened', repo: 'demo' }, { kind: 'prOpened', repo: 'web' },
    { kind: 'issueLabel', repo: 'demo', label: 'bug' },
  ]);
});

test('the first look only takes note; later ones bring what is new', () => {
  const first = freshEvents(undefined, [ev({ id: '1' }), ev({ id: '2' })]);
  assert.deepEqual(first.fresh, []);
  assert.deepEqual(first.seen, ['1', '2']);
  const next = freshEvents(first.seen, [ev({ id: '3' }), ev({ id: '2' })]);
  assert.deepEqual(next.fresh.map((e) => e.id), ['3']);
  assert.deepEqual(next.seen, ['3', '1', '2']);
});

test('what is seen is kept to the newest few hundred', () => {
  const many = Array.from({ length: SEEN_MAX + 10 }, (_, i) => String(i));
  const r = freshEvents(many, [ev({ id: 'new' })]);
  assert.equal(r.seen.length, SEEN_MAX);
  assert.equal(r.seen[0], 'new');
});

test('failed CI runs are read from gh, the rest left out', () => {
  const text = JSON.stringify([
    { databaseId: 7, conclusion: 'failure', headBranch: 'main', displayTitle: 'Add tax', url: 'u7' },
    { databaseId: 8, conclusion: 'success', headBranch: 'main' }, { databaseId: 9, conclusion: '', headBranch: 'main' },
  ]);
  assert.deepEqual(parseEvents({ kind: 'ciFailed', repo: 'demo' }, text), [{ kind: 'ciFailed', repo: 'demo', id: '7', branch: 'main', title: 'Add tax', url: 'u7' }]);
  assert.deepEqual(parseEvents({ kind: 'ciFailed', repo: 'demo' }, 'not json'), []);
});

test('opened PRs leave out the ones the app opened, and issues carry their labels', () => {
  const prs = JSON.stringify([{ number: 4, title: 'Mine', url: 'u4', baseRefName: 'main' }, { number: 5, title: 'Theirs', url: 'u5', baseRefName: 'main' }]);
  assert.deepEqual(parseEvents({ kind: 'prOpened', repo: 'demo' }, prs, new Set(['u4'])).map((e) => e.id), ['5']);
  assert.deepEqual(parseEvents({ kind: 'reviewRequested', repo: 'demo' }, prs, new Set(['u4'])).map((e) => e.id), ['4', '5']);
  const issues = JSON.stringify([{ number: 12, title: 'Tax', url: 'u12', labels: [{ name: 'bug' }, { name: 'ui' }] }]);
  assert.deepEqual(parseEvents({ kind: 'issueLabel', repo: 'demo', label: 'bug' }, issues)[0].labels, ['bug', 'ui']);
});

test('each watch reads GitHub with its own gh command', () => {
  assert.deepEqual(watchArgs({ kind: 'ciFailed', repo: 'demo' }).slice(0, 2), ['run', 'list']);
  assert.ok(watchArgs({ kind: 'reviewRequested', repo: 'demo' }).includes('review-requested:@me'));
  assert.ok(!watchArgs({ kind: 'prOpened', repo: 'demo' }).includes('--search'));
  const issue = watchArgs({ kind: 'issueLabel', repo: 'demo', label: 'bug' });
  assert.equal(issue[issue.indexOf('--label') + 1], 'bug');
});

test('an edited automation keeps or changes its limit', () => {
  const a: Automation = { id: 'a', title: 'x', prompt: 'x', trigger: { kind: 'ciFailed' }, enabled: true, lastRunAt: null, nextRunAt: null, createdAt: '', maxPerDay: 3 };
  assert.equal(editedAutomation(a, 'x', { kind: 'ciFailed' }, new Date()).maxPerDay, 3);
  assert.equal(editedAutomation(a, 'x', { kind: 'ciFailed' }, new Date(), null).maxPerDay, null);
});
