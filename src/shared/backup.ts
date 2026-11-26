// Daily copies of the state file, and going back to one when the file cannot be read (decision 129). From state
// version 2 on a day's backup is three files: the state file and the two it is split into (shared/stateSplit.ts).

export const BACKUPS_KEPT = 7;

/** The files of a day's backup, by the start of their names, and how each ends. */
export const BACKUP_PARTS = { state: 'json', chat: 'jsonl', 'tasks-done': 'jsonl' } as const;
export type BackupPart = keyof typeof BACKUP_PARTS;

const DAY = '(\\d{4}-\\d{2}-\\d{2})';
const nameOf = (part: BackupPart) => new RegExp(`^${part}-${DAY}\\.${BACKUP_PARTS[part]}$`);

/** The backup's file name for a day: "state-2026-11-22.json", in the local date. */
export function backupName(d: Date, part: BackupPart = 'state'): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${part}-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.${BACKUP_PARTS[part]}`;
}

/** The backups of one file among a folder's files, newest first. Anything else in the folder is left alone. */
export function backupsNewestFirst(names: readonly string[], part: BackupPart = 'state'): string[] {
  const name = nameOf(part);
  return names.filter((n) => name.test(n)).sort().reverse();
}

/** The day a backup is of: "2026-11-22". */
export function backupDay(name: string): string {
  return new RegExp(DAY).exec(name)?.[1] ?? '';
}

/** The backups to delete so that only the newest `keep` of each file stay. */
export function backupsToDrop(names: readonly string[], keep = BACKUPS_KEPT): string[] {
  return (Object.keys(BACKUP_PARTS) as BackupPart[]).flatMap((part) => backupsNewestFirst(names, part).slice(Math.max(0, keep)));
}

/**
 * What a state file's text is: `ok` when it is a JSON object, `empty` when there is nothing in it (a first run),
 * `broken` when there is something that is not one. Only `broken` is a reason to go back to a backup.
 */
export function stateText(text: string | null): 'ok' | 'empty' | 'broken' {
  if (text === null || !text.trim()) return 'empty';
  try {
    const v = JSON.parse(text.replace(/^\uFEFF/, ''));
    return v && typeof v === 'object' && !Array.isArray(v) ? 'ok' : 'broken';
  } catch {
    return 'broken';
  }
}
