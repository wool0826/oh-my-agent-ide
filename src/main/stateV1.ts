import { app, dialog } from 'electron';
import { paths } from './paths';
import { rollbackToV1 } from './stateFiles';
import { log } from './log';
import { t } from './i18n';
import { fakeMode } from './fake';

/**
 * `--state-v1`: the saved state is written back as the one file an older build reads, and the app quits without
 * opening (decision 213). Only the one running instance does it, so nothing else writes the files meanwhile.
 * The write-back needs no Electron and runs before ready; the app then ends with an orderly quit, before ready when
 * there is no dialog to show, since `app.exit` just after ready crashed on Windows (0xC0000005, T-0124).
 */
export function backToV1() {
  let said: string;
  let failed = false;
  try {
    const r = rollbackToV1(paths());
    log.info('state-v1', JSON.stringify(r));
    if (r.kind === 'done') said = t('state.v1Done', { tasks: r.tasks, chat: r.chat });
    else if (r.why === 'missing' || r.why === 'v1') said = t('state.v1Already');
    else {
      failed = true;
      said = r.why === 'short' ? t('state.v1Short') : t('state.v1Failed', { error: r.why === 'newer' ? `format ${r.version}` : 'state.json cannot be read' });
    }
  } catch (e) {
    log.error('state-v1 failed', e);
    failed = true;
    said = t('state.v1Failed', { error: e instanceof Error ? e.message : String(e) });
  }
  const quit = () => {
    // app.quit always exits with 0; the failure's 1 is set as the quit ends.
    if (failed) app.once('will-quit', () => app.exit(1));
    app.quit();
  };
  if (fakeMode()) quit();
  else void app.whenReady().then(() => { dialog.showMessageBoxSync({ type: failed ? 'error' : 'info', message: said }); quit(); });
}
