import { accounts } from './accounts';
import { dispatcher } from './agents/dispatcher';
import { workers } from './agents/workers';

/** Continue work that a usage limit paused: Worker tasks, held messages, and the Dispatcher. */
export function retryAfterLimits() {
  workers.retryQueued();
  dispatcher.retryHeld();
}

/** While a usage limit holds every account, wake up right after the first one resets. */
let limitTimer: NodeJS.Timeout | null = null;
export function scheduleLimitRetry() {
  if (limitTimer) clearTimeout(limitTimer);
  limitTimer = null;
  const at = accounts.nextFreeAt();
  if (at === null) return;
  limitTimer = setTimeout(() => {
    limitTimer = null;
    retryAfterLimits();
    scheduleLimitRetry();
  }, Math.max(1_000, at - Date.now() + 5_000));
}
