import path from 'node:path';
import { loadSettings } from './settings';
import { ensureDir } from './util';

let runningHome: string | null = null;

/** Layout under the IDE home. The home is read once per launch, so a new one in settings waits for a restart. */
export function paths() {
  const home = (runningHome ??= loadSettings().home);
  return {
    home,
    repos: path.join(home, 'repos'),
    worktrees: path.join(home, 'worktrees'),
    workspaces: path.join(home, 'workspaces'),
    memory: path.join(home, 'memory'),
    plugin: path.join(home, 'plugin'),
    data: path.join(home, 'data'),
    state: path.join(home, 'data', 'state.json'),
    /** Chat that left state.json and tasks that ended, one record a line, only appended to (shared/stateSplit.ts). */
    chatFile: path.join(home, 'data', 'chat.jsonl'),
    tasksDone: path.join(home, 'data', 'tasks-done.jsonl'),
    backups: path.join(home, 'data', 'backups'),
    workerLogs: path.join(home, 'data', 'workers'),
    appLog: path.join(home, 'data', 'app.log'),
    /** Errors nothing caught and window pages that died, with their stacks (crash.ts). */
    crashLog: path.join(home, 'data', 'crash.log'),
    /** Present while the app runs; left behind by a run that did not quit (crash.ts). */
    runMarker: path.join(home, 'data', 'running.json'),
  };
}

export function ensureHome() {
  const p = paths();
  for (const d of [p.home, p.repos, p.worktrees, p.workspaces, p.memory, p.data, p.workerLogs]) ensureDir(d);
}
