// Daily copies of the state file, and going back to one when the file cannot be read (decision 129).

export const BACKUPS_KEPT = 7;
const NAME = /^state-(\d{4}-\d{2}-\d{2})\.json$/;

/** The backup's file name for a day: "state-2026-11-22.json", in the local date. */
export function backupName(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `state-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.json`;
}

/** The backups among a folder's files, newest first. Anything else in the folder is left alone. */
export function backupsNewestFirst(names: readonly string[]): string[] {
  return names.filter((n) => NAME.test(n)).sort().reverse();
}

/** The backups to delete so that only the newest `keep` stay. */
export function backupsToDrop(names: readonly string[], keep = BACKUPS_KEPT): string[] {
  return backupsNewestFirst(names).slice(Math.max(0, keep));
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
