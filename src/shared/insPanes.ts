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
