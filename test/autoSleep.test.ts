import { test } from 'node:test';
import assert from 'node:assert/strict';
import { busyReason, countdownText, sleepArm, sleepCommand, SLEEP_SECONDS, type SleepInput } from '../src/shared/autoSleep';
import type { PrChecks, TaskStatus } from '../src/shared/types';

const idle = (): SleepInput => ({ tasks: [], workers: [], decisions: [], mergeQueue: [], dispatcherBusy: false, shellAsking: 0 });
const task = (status: TaskStatus, more: Partial<SleepInput['tasks'][number]> = {}) => ({ id: 'T-1', status, ...more });
const ci = (state: PrChecks['ci']): PrChecks => ({ ci: state, failed: [], conflicts: false, review: null });

test('autoSleep: what holds the sleep and what does not, state by state', () => {
  const rows: [string, Partial<SleepInput>, boolean][] = [
    ['nothing at all', {}, false],
    ['a running task', { tasks: [task('running')] }, true],
    ['a task waiting for an answer', { tasks: [task('waiting')] }, true],
    ['a task queued for a slot or paused by a usage limit', { tasks: [task('queued')] }, true],
    ['a task blocked behind another PR', { tasks: [task('blocked')] }, true],
    ['a done task', { tasks: [task('done')] }, false],
    ['a failed or stopped task', { tasks: [task('failed')] }, false],
    ['a cancelled task', { tasks: [task('cancelled')] }, false],
    ['an open PR with CI running', { tasks: [task('pr_open', { prState: 'OPEN', prChecks: ci('pending') })] }, true],
    ['an open PR whose checks are not known yet', { tasks: [task('pr_open', { prState: 'OPEN', prChecks: null })] }, true],
    ['an open PR that waits on the Dispatcher', { tasks: [task('pr_open', { prState: 'OPEN', prChecks: ci('passing'), waitingOn: 'dispatcher' })] }, true],
    ['an open PR with green CI left for review', { tasks: [task('pr_open', { prState: 'OPEN', prChecks: ci('passing') })] }, false],
    ['an open PR with red CI left to the user', { tasks: [task('pr_open', { prState: 'OPEN', prChecks: ci('failing') })] }, false],
    ['a pr_open task whose PR already merged', { tasks: [task('pr_open', { prState: 'MERGED', prChecks: null })] }, false],
    ['a PR in the merge queue', { mergeQueue: [{ taskId: 'T-1' }] }, true],
    ['a pending decision', { decisions: [{ id: 'd1', status: 'pending' }] }, true],
    ['an answered decision', { decisions: [{ id: 'd1', status: 'answered' }] }, false],
    ['the Dispatcher in a turn', { dispatcherBusy: true }, true],
    ['a running Worker', { workers: [{ id: 'W-1', status: 'running' }] }, true],
    ['a starting Worker', { workers: [{ id: 'W-1', status: 'starting' }] }, true],
    ['a waiting Worker', { workers: [{ id: 'W-1', status: 'waiting' }] }, true],
    ['idle, failed and archived Workers', { workers: [{ id: 'W-1', status: 'idle' }, { id: 'W-2', status: 'error' }, { id: 'W-3', status: 'archived' }] }, false],
    ['a shell run whose result goes to the Dispatcher', { shellAsking: 1 }, true],
  ];
  for (const [name, part, busy] of rows) assert.equal(busyReason({ ...idle(), ...part }) !== null, busy, name);
});

test('autoSleep: the reason names what holds the sleep', () => {
  assert.equal(busyReason({ ...idle(), tasks: [{ id: 'T-7', status: 'running' }] }), 'T-7 running');
  assert.equal(busyReason({ ...idle(), tasks: [{ id: 'T-8', status: 'pr_open', prState: 'OPEN', prChecks: ci('pending') }] }), 'T-8 CI pending');
});

function rig() {
  const calls: string[] = [];
  const arm = sleepArm({ sleep: () => calls.push('sleep'), release: () => calls.push('release'), notify: () => calls.push('notify'), log: () => {} });
  return { arm, calls };
}

const S = SLEEP_SECONDS * 1000;
const busy = (): SleepInput => ({ ...idle(), tasks: [{ id: 'T-1', status: 'running' }] });

test('autoSleep: arming with no work left starts the countdown at once', () => {
  const { arm, calls } = rig();
  arm.arm('toolbar', idle(), 1000);
  assert.deepEqual(arm.view(), { armed: true, until: 1000 + S });
  assert.deepEqual(calls, ['notify']);
});

test('autoSleep: at the end of the countdown it lets go of the blocker, then sleeps once and disarms', () => {
  const { arm, calls } = rig();
  arm.arm('toolbar', idle(), 0);
  arm.sync(idle(), S - 1);
  assert.deepEqual(calls, ['notify']);
  arm.sync(idle(), S);
  assert.deepEqual(calls, ['notify', 'release', 'sleep']);
  assert.deepEqual(arm.view(), { armed: false, until: null });
  arm.sync(idle(), S * 3);
  assert.equal(calls.filter((c) => c === 'sleep').length, 1);
});

test('autoSleep: cancelling disarms and never sleeps', () => {
  const { arm, calls } = rig();
  arm.arm('toolbar', idle(), 0);
  assert.equal(arm.disarm('toolbar'), true);
  arm.sync(idle(), S * 2);
  assert.ok(!calls.includes('sleep'));
  assert.deepEqual(arm.view(), { armed: false, until: null });
});

test('autoSleep: armed while work runs, the countdown waits for it to end', () => {
  const { arm, calls } = rig();
  arm.arm('Dispatcher', busy(), 0);
  assert.deepEqual(arm.view(), { armed: true, until: null });
  arm.sync(busy(), S * 5);
  assert.deepEqual(calls, []);
  arm.sync(idle(), S * 5);
  assert.equal(arm.view().until, S * 6);
});

test('autoSleep: new work stops the countdown but keeps the arm, and a fresh one starts after it', () => {
  const { arm, calls } = rig();
  arm.arm('toolbar', idle(), 0);
  arm.sync(busy(), S / 2);
  assert.deepEqual(arm.view(), { armed: true, until: null });
  arm.sync(busy(), S * 2);
  assert.ok(!calls.includes('sleep'));
  arm.sync(idle(), S * 2);
  assert.equal(arm.view().until, S * 3);
  arm.sync(idle(), S * 3);
  assert.deepEqual(calls, ['notify', 'notify', 'release', 'sleep']);
});

test('autoSleep: never armed, it never sleeps', () => {
  const { arm, calls } = rig();
  assert.equal(arm.sync(idle(), 0), false);
  arm.sync(idle(), S * 10);
  assert.deepEqual(calls, []);
  assert.equal(arm.disarm('toolbar'), false);
});

test('autoSleep: arming twice keeps the running countdown', () => {
  const { arm } = rig();
  arm.arm('toolbar', idle(), 0);
  assert.equal(arm.arm('Dispatcher', idle(), 5000), false);
  assert.equal(arm.view().until, S);
});

test('autoSleep: countdown text is m:ss and never negative', () => {
  assert.equal(countdownText(60_000), '1:00');
  assert.equal(countdownText(41_200), '0:42');
  assert.equal(countdownText(-5), '0:00');
});

test('autoSleep: each platform has a sleep command, and Windows asks for sleep, not hibernate', () => {
  const win = sleepCommand('win32')!;
  assert.equal(win.file, 'powershell.exe');
  assert.match(win.args.at(-1)!, /SetSuspendState\(\$false, \$false, \$false\)/);
  assert.ok(!win.args.join(' ').includes('rundll32'));
  assert.deepEqual(sleepCommand('darwin'), { file: 'pmset', args: ['sleepnow'] });
  assert.deepEqual(sleepCommand('linux'), { file: 'systemctl', args: ['suspend'] });
  assert.equal(sleepCommand('aix'), null);
});
