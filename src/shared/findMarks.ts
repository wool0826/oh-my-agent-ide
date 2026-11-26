// Marking what a search found in a thread: every match, the current one, and the ticks beside the scroll bar
// (decision 228).

/**
 * Where the words occur in `text`, ignoring case: [start, end) pairs in order, none overlapping (a longer word wins
 * where two start at the same place). Empty when lower-casing would change the text's length, so the pairs always
 * point into `text` itself.
 */
export function matchRanges(text: string, words: readonly string[]): [number, number][] {
  const low = text.toLowerCase();
  if (low.length !== text.length) return [];
  const all: [number, number][] = [];
  for (const w of words) {
    if (!w) continue;
    for (let i = low.indexOf(w); i >= 0; i = low.indexOf(w, i + w.length)) all.push([i, i + w.length]);
  }
  all.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const out: [number, number][] = [];
  for (const r of all) if (!out.length || r[0] >= out[out.length - 1][1]) out.push(r);
  return out;
}

/** The match to make current: the first one at or after `from` (a message's first), else the last one. -1 for none. */
export function firstFrom(count: number, from: number): number {
  if (count <= 0) return -1;
  return from >= 0 && from < count ? from : count - 1;
}

/** "3/5" for the bar; "0/0" when nothing matches. */
export function findCount(cur: number, count: number): string {
  return count > 0 ? `${cur + 1}/${count}` : '0/0';
}

/** A tick's place down the scroll bar, in percent of the track, for a match `top` pixels into `height` of content. */
export function tickAt(top: number, height: number): number {
  if (height <= 0) return 0;
  return Math.round(Math.min(1, Math.max(0, top / height)) * 1000) / 10;
}
