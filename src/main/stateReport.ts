import { store } from './store';
import { log } from './log';
import { t } from './i18n';

/** What loading the state file found that the user must hear about, said once in the chat and in the log. */
export function reportStateLoad() {
  // The state file was unreadable: say what was done about it, once, where the user will see it.
  if (store.restoredFrom) {
    log.error('state file unreadable; restored from', store.restoredFrom);
    store.chat('error', store.restoredFrom === 'none' ? t('backup.lost') : t('backup.restored', { day: store.restoredFrom }));
  }
  // The state is not written this launch (shared/migrate.ts): the user hears why before anything is lost.
  const ro = store.readOnly;
  if (ro) {
    log.error('state file opened read-only', JSON.stringify(ro));
    store.chat('error', ro.why === 'newer' ? t('state.newer', { version: ro.version }) : t('state.migrateFailed', { error: ro.error }));
  }
  if (store.migrated) log.info('state file migrated from version', store.migrated.from, 'copy kept at', store.migrated.copy);
  // One of the two files beside state.json held fewer records than state.json counted: what the backups gave back.
  for (const r of store.repaired) {
    log.error('state file lost records', JSON.stringify(r));
    store.chat('error', t(r.part === 'chat' ? 'state.chatDamaged' : 'state.tasksDamaged', { lost: r.restored + r.missing, restored: r.restored, missing: r.missing }));
  }
  if (store.skippedLines) log.warn('lines skipped in chat.jsonl and tasks-done.jsonl', store.skippedLines);
}
