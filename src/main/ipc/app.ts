import fs from 'node:fs';
import path from 'node:path';
import { app, shell } from 'electron';
import { handle } from './handle';
import { paths } from '../paths';
import { opensSafely } from '../../shared/openSafe';
import { savePastedImage } from '../attachments';
import { applyUpdate, restartIntoUpdate } from '../update';
import { updateBlockers } from '../snapshot';
import { fakeMode } from '../fake';
import { e2eOpened } from './e2e';

/** Opening links and files on the computer, pasted images, the version, and restarting into an update. */
export function registerAppIpc() {
  handle('open:external', (url: string) => {
    if (fakeMode()) { e2eOpened.push(['open:external', url]); return; }
    if (/^https?:\/\//.test(url)) return shell.openExternal(url);
  });
  handle('open:path', async (p: string) => {
    if (fakeMode()) { e2eOpened.push(['open:path', p]); return; }
    // A path an agent reported may be a program or a script: those are shown in their folder, not run.
    let dir = false;
    try { dir = fs.statSync(p).isDirectory(); } catch { /* openPath says it is missing */ }
    if (!opensSafely(p, dir) && fs.existsSync(p)) { shell.showItemInFolder(p); return; }
    const err = await shell.openPath(p);
    if (err) throw new Error(err);
  });
  // A screenshot pasted into a composer is kept under the IDE home, so the agent can still read it later.
  handle('attach:pasteImage', (type: string, bytes: Uint8Array) => savePastedImage(path.join(paths().data, 'pasted'), type, bytes));
  handle('reveal:path', (p: string) => shell.showItemInFolder(p));
  handle('app:version', () => app.getVersion());
  handle('app:relaunch', () => { if (restartIntoUpdate(updateBlockers())) return; app.relaunch(); app.quit(); });
  // Restart into the downloaded update; refused (false) while a Worker, a queued task or the Dispatcher is working.
  handle('update:apply', () => applyUpdate(updateBlockers()));
}
