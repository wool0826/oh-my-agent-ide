// "Sleep when done" (shared/autoSleep.ts) wired to the app: the work it waits for, the countdown's clock and the OS call.
import { execFile } from 'node:child_process';
import { SLEEP_SECONDS, busyReason, sleepArm, sleepCommand, type SleepInput, type SleepView } from '../shared/autoSleep';
import { store } from './store';
import { shell } from './shell';
import { log } from './log';
import { t } from './i18n';
import { notifyInfo } from './notify';
import { fakeMode } from './fake';

interface Hooks {
  dispatcherBusy(): boolean;
  dispatcherDue(): boolean;
  /** Lets go of the keep-awake blocker (shared/awake.ts). */
  release(): void;
  pushState(): void;
}

let hooks: Hooks | null = null;
let timer: NodeJS.Timeout | null = null;
/** e2e: times the computer would have been put to sleep. */
let fakeSleeps = 0;
/** e2e: added to the clock, so a test ends a countdown without waiting for it. */
let skew = 0;

const now = () => Date.now() + skew;

function osSleep() {
  if (fakeMode()) { fakeSleeps++; return; }
  const cmd = sleepCommand(process.platform);
  if (!cmd) return log.warn('autosleep: no sleep command on', process.platform);
  log.info('autosleep: running', cmd.file, cmd.args[0]);
  execFile(cmd.file, cmd.args, { timeout: 30_000, windowsHide: true }, (e, _out, err) => {
    if (e) log.warn('autosleep: sleep command failed', e.message, String(err).trim());
    else log.info('autosleep: sleep command returned');
  });
}

const arm = sleepArm({
  sleep: () => {
    store.chat('event', t('sleep.slept'));
    osSleep();
  },
  release: () => hooks?.release(),
  log: (m) => log.info(`autosleep: ${m}`),
  notify: () => notifyInfo(t('sleep.title'), t('sleep.body', { s: String(SLEEP_SECONDS) })),
});

function input(): SleepInput {
  const d = store.data;
  return {
    tasks: d.tasks,
    workers: d.workers,
    decisions: d.decisions,
    mergeQueue: d.mergeQueue ?? [],
    dispatcherBusy: hooks?.dispatcherBusy() ?? false,
    dispatcherDue: hooks?.dispatcherDue() ?? false,
    shellAsking: shell.asking,
  };
}

/** The 1 s clock runs only while a countdown does. */
function clock() {
  const running = arm.view().until !== null;
  if (running && !timer) timer = setInterval(() => sync(), 1000);
  if (!running && timer) { clearInterval(timer); timer = null; }
}

function sync() {
  if (arm.sync(input(), now())) hooks?.pushState();
  clock();
}

export const autoSleep = {
  init(h: Hooks) { hooks = h; },
  /** Called whenever the store changes. */
  sync,
  arm(by: string): SleepView {
    if (arm.arm(by, input(), now())) hooks?.pushState();
    clock();
    return arm.view();
  },
  disarm(by: string): SleepView {
    if (arm.disarm(by)) hooks?.pushState();
    clock();
    return arm.view();
  },
  view: (): SleepView => arm.view(),
  /** What still holds the sleep besides the Dispatcher's own turn, for its answer. */
  reason: () => busyReason({ ...input(), dispatcherBusy: false }),
  e2e: {
    tick(ms: number) { skew += ms; sync(); },
    get slept() { return fakeSleeps; },
  },
};
