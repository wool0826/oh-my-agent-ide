import path from 'node:path';
import { loadSettings } from './settings';
import { ensureDir } from './util';

/** IDE 홈 폴더 아래 구조. 설정에서 홈을 바꾸면 다음 실행부터 새 위치를 쓴다. */
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
