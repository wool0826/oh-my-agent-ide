import { loadSettings, settingsView } from './settings';
import { store } from './store';
import { accounts } from './accounts';
import { memorySync } from './memory';
import { addingRepo } from './repos';
import { dispatcher } from './agents/dispatcher';
import { runs } from './runs';
import { automations } from './automations';
import { updateView } from './update';
import { applyBlockers } from '../shared/update';
import { fakeMode } from './fake';
import { lastPreflight } from './preflight';
import { failedCount } from '../shared/preflight';
import { month } from './util';
import { CHAT_SNAPSHOT } from '../shared/paging';
import { openTaskIds } from '../shared/currentTask';
import type { AppState } from '../shared/types';

/** What a restart into a downloaded update would wait for. */
export const updateBlockers = () => applyBlockers({ workers: store.data.workers, tasks: store.data.tasks, dispatcherBusy: dispatcher.busy });

/** The state the window shows. */
export function snapshot(): AppState {
  const d = store.data;
  const byId = new Map(d.tasks.map((x) => [x.id, x]));
  return {
    ready: true,
    // Fake agents need no account; an end-to-end test of the first run asks for the account screen (OMA_E2E_NO_ACCOUNT).
    setupNeeded: (!fakeMode() || process.env.OMA_E2E_NO_ACCOUNT === '1') && accounts.list().length === 0,
    settings: settingsView(),
    accounts: accounts.views(),
    usageClock: accounts.clock,
    repos: d.repos,
    workers: d.workers,
    tasks: d.tasks,
    openTasks: openTaskIds(d.workers, (id) => byId.get(id)),
    mergeQueue: d.mergeQueue ?? [],
    decisions: d.decisions,
    autoAnswers: d.autoAnswers,
    memorySuggestions: loadSettings().memorySuggest ? d.memorySuggestions.filter((x) => x.status === 'pending') : [],
    chat: d.chat.slice(-CHAT_SNAPSHOT),
    // All of them, not only those in the chat snapshot, so the inspector's "Show more" reaches every one.
    results: d.chat.filter((c) => (c.kind === 'result' || (c.kind === 'error' && c.ref)) && !c.cleared),
    memos: d.memos ?? [],
    automations: automations.list(),
    scripts: d.scripts ?? [],
    runs: runs.views(),
    memorySync: memorySync(),
    update: updateView(updateBlockers()),
    fake: fakeMode(),
    preflightFailed: failedCount(lastPreflight() ?? []),
    repoAdding: addingRepo(),
    dispatcher: { busy: dispatcher.busy, contextTokens: d.dispatcher.contextTokens, accountId: d.dispatcher.accountId, statusText: dispatcher.statusText, busySince: dispatcher.busySince, spend: d.dispatcher.spend?.[month()] ?? null },
  };
}
