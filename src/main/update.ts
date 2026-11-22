// Looks for a newer release: shortly after launch, then every six hours (decision 120).

import { app } from 'electron';
import { loadSettings } from './settings';
import { log } from './log';
import { RELEASE_API, updateFrom, type UpdateInfo } from '../shared/update';

let found: UpdateInfo | null = null;
let timer: NodeJS.Timeout | null = null;

export const updateInfo = () => (loadSettings().updateCheck ? found : null);

/** One anonymous GET of the public repository's latest release. Nothing about the user or the app's data is sent. */
export async function checkUpdate(onChange: (u: UpdateInfo) => void) {
  if (!loadSettings().updateCheck) return;
  try {
    const res = await fetch(RELEASE_API, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'oh-my-agent-ide' }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return; // 404 while there are no releases yet, 403 when rate-limited
    const next = updateFrom(await res.json(), app.getVersion());
    if (next && next.version !== found?.version) { found = next; onChange(next); }
  } catch (e) {
    log.warn('update check', (e as Error).message);
  }
}

export function startUpdateCheck(onChange: (u: UpdateInfo) => void) {
  if (timer) return;
  setTimeout(() => void checkUpdate(onChange), 20_000);
  timer = setInterval(() => void checkUpdate(onChange), 6 * 3600_000);
}
