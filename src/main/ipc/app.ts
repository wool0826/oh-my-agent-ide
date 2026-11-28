import fs from 'node:fs';
import path from 'node:path';
import { app, shell } from 'electron';
import { handle } from './handle';
import { log } from '../log';
import { paths } from '../paths';
import { opensSafely } from '../../shared/openSafe';
import { savePastedImage } from '../attachments';
import { applyUpdate, restartIntoUpdate } from '../update';
import { updateBlockers } from '../snapshot';
import { fakeMode } from '../fake';
import { e2eOpened } from './e2e';
import { autoSleep } from '../sleep';
import { editorsFound, openWith, type OpenWhat } from '../openWith';

/** Opening links and files on the computer, pasted images, the version, restarting into an update, and sleep when done. */
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
  // A Worker's folder in the editor, a terminal or the file manager (item 3A); which editors this computer has.
  handle('open:with', (what: OpenWhat, folder: string) => openWith(what, String(folder ?? '')));
  handle('open:editors', () => editorsFound());
  handle('open:exists', (folder: string) => { try { return fs.statSync(String(folder)).isDirectory(); } catch { return false; } });
  handle('app:version', () => app.getVersion());
  // Something the window noticed that belongs in the app log (a Worker drawn with another task than main's).
  // At most 50 a run, so a window stuck in a loop cannot fill the log.
  let warns = 0;
  handle('app:warn', (text: unknown) => { if (warns++ < 50) log.warn(`window: ${String(text).slice(0, 500)}`); });
  handle('app:relaunch', () => { if (restartIntoUpdate(updateBlockers())) return; app.relaunch(); app.quit(); });
  // Restart into the downloaded update; refused (false) while a Worker, a queued task or the Dispatcher is working.
  handle('update:apply', () => applyUpdate(updateBlockers()));
  // "Sleep when done" from the toolbar: on, or off (which also cancels a countdown).
  handle('sleep:set', (on: boolean) => (on ? autoSleep.arm('toolbar') : autoSleep.disarm('toolbar')));
}
