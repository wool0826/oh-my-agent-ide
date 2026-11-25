// The right sidebar's two layouts. Under SPLIT_AT it is one column and the selected item opens in place; from
// SPLIT_AT the list keeps LIST_W and the rest is a detail pane for the selected item. With nothing selected it
// stays one column at any width.

/** The sidebar width from which the list and the selected item sit side by side. */
export const SPLIT_AT = 560;
/** The list column in two panes (--ins-list-w in styles.css). */
export const LIST_W = 248;

export function paneMode(width: number, hasSelection: boolean): 'one' | 'split' {
  return hasSelection && width >= SPLIT_AT ? 'split' : 'one';
}

/** The selected item of a list: the current one while it is still there, otherwise `fallback`. */
export function keepPick(ids: string[], cur: string | null, fallback: string | null): string | null {
  return cur && ids.includes(cur) ? cur : fallback;
}

/** The item ↑/↓ (and Home/End) go to in a list of `count` from `at`, stopping at the ends; null for other keys. */
export function listStep(count: number, at: number, key: string): number | null {
  if (!count) return null;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (key !== 'ArrowDown' && key !== 'ArrowUp') return null;
  if (at < 0) return 0;
  return Math.min(count - 1, Math.max(0, at + (key === 'ArrowDown' ? 1 : -1)));
}

/** The item that takes the focus once `gone` is removed from `keys`: the next one, the one before it at the end. */
export function focusAfter(keys: string[], gone: string): string | null {
  const i = keys.indexOf(gone);
  if (i < 0) return null;
  return keys[i + 1] ?? keys[i - 1] ?? null;
}

export type DayWord = 'today' | 'tomorrow' | 'yesterday' | 'week' | 'date';

/** How a day reads next to `now`, in local time: a word for the days around today, a weekday within a week ahead. */
export function dayWord(at: Date, now: Date): DayWord {
  const day = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000;
  const n = day(at) - day(now);
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  return n > 1 && n < 7 ? 'week' : 'date';
}
