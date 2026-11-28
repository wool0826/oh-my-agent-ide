import { handle } from './handle';
import { workers } from '../agents/workers';
import { automations } from '../automations';
import { checkPrs, pollAutomationEvents, runMergeQueue } from '../prmonitor';
import { diagnostics } from '../diagnostics';
import { autoSleep } from '../sleep';
import { badge, usageNotes } from '../notify';
import { accounts } from '../accounts';
import { e2eWindow } from '../windowPlace';

/** With fake agents (the end-to-end tests), what would have been opened on the computer, kept instead. */
export const e2eOpened: [string, string][] = [];

/** Hooks for the end-to-end tests (test/e2e), which have no button for them; the window does not call them. */
export function registerE2eIpc(awake: { readonly held: boolean }) {
  handle('diag:text', () => diagnostics());
  handle('e2e:window', (op: Parameters<typeof e2eWindow>[0]) => e2eWindow(op ?? {}));
  handle('pr:check', () => checkPrs({ full: true }));
  // The half-minute checks run as if `ms` had passed: a slot given up after a long wait, a daily automation's time.
  handle('e2e:autoPoll', () => pollAutomationEvents());
  handle('e2e:clock', (ms: number) => { const now = Date.now() + Number(ms); workers.sweepWaiting(now); automations.tick(new Date(now)); });
  // What a test run would have opened on the computer (open:path, open:external keep it instead).
  handle('e2e:opened', () => e2eOpened);
  handle('e2e:badge', () => badge);
  // A session reports an account's 5h usage; the usage warnings told so far (T-0180).
  handle('e2e:usage', (id: string, pct: number, resetsAt: string) => accounts.applyUsage(id, { five_hour: { utilization: pct, resets_at: resetsAt } }));
  handle('e2e:usageNotes', () => usageNotes);
  handle('mq:run', () => runMergeQueue());
  handle('e2e:awake', () => awake.held);
  // "Sleep when done": the countdown's clock moved on by `ms`, and how often the computer would have slept.
  handle('e2e:sleepTick', (ms: number) => autoSleep.e2e.tick(Number(ms)));
  handle('e2e:slept', () => autoSleep.e2e.slept);
}
