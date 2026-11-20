import path from 'node:path';
import { loadSettings } from './settings';
import { ensureDir } from './util';

/** Layout under the IDE home. A new home in settings takes effect on the next launch. */
export function paths() {
  const home = loadSettings().home;
  return {
    home,
    repos: path.join(home, 'repos'),
    worktrees: path.join(home, 'worktrees'),
    workspaces: path.join(home, 'workspaces'),
    memory: path.join(home, 'memory'),
    plugin: path.join(home, 'plugin'),
    data: path.join(home, 'data'),
    state: path.join(home, 'data', 'state.json'),
    workerLogs: path.join(home, 'data', 'workers'),
    appLog: path.join(home, 'data', 'app.log'),
  };
}

export function ensureHome() {
  const p = paths();
  for (const d of [p.home, p.repos, p.worktrees, p.workspaces, p.memory, p.data, p.workerLogs]) ensureDir(d);
}
