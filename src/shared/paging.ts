// Long lists load a page at a time (decision 85). Conversation threads (a Worker's log, the Dispatcher chat)
// show their latest page and load the one before it when the reader scrolls up to the top; the other lists
// (results, auto-answers, archived Workers, a repository's tasks, memory search hits) end in a "Show more"
// button. Pure, so the main process, the renderer and the tests share it.

/** Items per page, by list. */
export const PAGE = {
  /** A Worker's conversation (its jsonl log). */
  log: 200,
  /** The Dispatcher chat thread. */
  chat: 100,
  results: 30,
  autos: 30,
  archived: 20,
  repoTasks: 15,
  memHits: 30,
} as const;

/** Chat items in each state push. Older ones come from `chat:page`. */
export const CHAT_SNAPSHOT = 400;

/**
 * Where a page of `limit` items ending before index `before` starts and ends, in a list of `total` items.
 * Without `before`, the page is the last one. `before` past the end counts as the end.
 */
export function pageBefore(total: number, before: number | undefined, limit: number): { start: number; end: number } {
  const end = Math.max(0, Math.min(total, before ?? total));
  return { start: Math.max(0, end - Math.max(0, limit)), end };
}

/**
 * Up to `limit` items right before the one with id `before` (chronological), and whether more come before them.
 * An id no longer in the list (dropped by the cap) has nothing before it that is still kept.
 */
export function itemsBefore<T extends { id: string }>(items: T[], before: string, limit: number): { items: T[]; more: boolean } {
  const i = items.findIndex((x) => x.id === before);
  if (i < 0) return { items: [], more: false };
  const { start } = pageBefore(items.length, i, limit);
  return { items: items.slice(start, i), more: start > 0 };
}

/**
 * The older items the renderer holds before the state snapshot, after the snapshot moved on from `prev` to `next`.
 * Items that fell off the front of the snapshot join the end of `older`, so nothing goes missing between them,
 * when older items are held or the thread shows one of them (its first shown item is `from`); otherwise they
 * aren't needed. If the two snapshots don't overlap (a burst longer than a snapshot), the older items are no
 * longer next to the snapshot and are dropped.
 */
export function slideOlder<T extends { id: string }>(older: T[], prev: T[], next: T[], from: string | null = null): T[] {
  const i = next.length ? prev.findIndex((x) => x.id === next[0].id) : -1;
  if (i < 0) return [];
  if (i === 0) return older;
  const slid = prev.slice(0, i);
  return older.length || slid.some((x) => x.id === from) ? [...older, ...slid] : older;
}

/**
 * The index of the first item a thread shows, out of `total` held, given the one shown last time (`from`, or -1
 * when there is none yet). The start stays put while new items arrive below, so the place of a reader who
 * scrolled up doesn't move. Following the bottom, a thread grown past two pages goes back to the last page.
 */
export function threadStart(total: number, from: number, page: number, follow: boolean): number {
  if (from < 0 || from > total) return Math.max(0, total - page);
  if (follow && total - from > 2 * page) return total - page;
  return from;
}

/** The first `shown` items of a list, and how many are left after them. */
export function firstPage<T>(items: T[], shown: number): { items: T[]; left: number } {
  const n = Math.max(0, shown);
  return { items: items.slice(0, n), left: Math.max(0, items.length - n) };
}

/** How many to show so the item at `index` is on screen: whole pages of `page`, never fewer than `shown`. */
export function pagesFor(index: number, shown: number, page: number): number {
  return index < shown ? shown : Math.ceil((index + 1) / page) * page;
}
