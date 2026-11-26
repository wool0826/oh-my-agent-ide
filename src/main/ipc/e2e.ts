import { handle } from './handle';
import { workers } from '../agents/workers';
import { automations } from '../automations';
import { checkPrs, runMergeQueue } from '../prmonitor';
import { diagnostics } from '../diagnostics';

/** With fake agents (the end-to-end tests), what would have been opened on the computer, kept instead. */
export const e2eOpened: [string, string][] = [];

/** Hooks for the end-to-end tests (test/e2e), which have no button for them; the window does not call them. */
export function registerE2eIpc(awake: { readonly held: boolean }) {
  handle('diag:text', () => diagnostics());
  handle('pr:check', () => checkPrs({ full: true }));
  // The half-minute checks run as if `ms` had passed: a slot given up after a long wait, a daily automation's time.
  handle('e2e:clock', (ms: number) => { const now = Date.now() + Number(ms); workers.sweepWaiting(now); automations.tick(new Date(now)); });
  // What a test run would have opened on the computer (open:path, open:external keep it instead).
  handle('e2e:opened', () => e2eOpened);
  handle('mq:run', () => runMergeQueue());
  handle('e2e:awake', () => awake.held);
}
