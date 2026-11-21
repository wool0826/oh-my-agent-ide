// Scroll positions kept across a re-render that replaces the scrolled elements.
// The renderer rebuilds lists and cards with innerHTML on every state push, so an element that scrolls
// (a list, a plan, a diff) is a new element at offset 0 each time. Elements that should keep their place carry
// a data-scroll key unique within the rendered root; keepScroll() in app.ts saves their offsets before
// the render and puts them back on the new elements with the same key. Pure, so it is testable without a DOM.

/** What saving and restoring reads and writes on an element. */
export interface Scrollable {
  readonly dataset: { scroll?: string };
  scrollTop: number;
  scrollLeft: number;
}

/** Where a keyed element was, and how long its scrollbar had left to show (ms, 0 when hidden). */
export interface ScrollPos {
  top: number;
  left: number;
  bar: number;
}

/**
 * The offsets of the keyed elements worth restoring: scrolled away from the start, or with their scrollbar
 * showing. An element at the start with no bar needs nothing, since a new element starts there.
 * If two elements share a key, the first one wins.
 */
export function saveScroll<T extends Scrollable>(els: Iterable<T>, barLeft: (el: T) => number = () => 0): Map<string, ScrollPos> {
  const saved = new Map<string, ScrollPos>();
  for (const el of els) {
    const key = el.dataset.scroll;
    if (!key || saved.has(key)) continue;
    const pos = { top: el.scrollTop, left: el.scrollLeft, bar: Math.max(0, barLeft(el)) };
    if (pos.top || pos.left || pos.bar) saved.set(key, pos);
  }
  return saved;
}

/**
 * Put the saved offsets back on the elements that now carry those keys. Only offsets that differ are written,
 * so an element the render kept is left alone. Returns the elements whose scrollbar was showing, with the time
 * it had left, so the caller keeps it up on a new element without starting the countdown over.
 */
export function restoreScroll<T extends Scrollable>(els: Iterable<T>, saved: Map<string, ScrollPos>, moved: (el: T) => void = () => {}): [T, number][] {
  const bars: [T, number][] = [];
  if (!saved.size) return bars;
  const done = new Set<string>();
  for (const el of els) {
    const key = el.dataset.scroll;
    const pos = key ? saved.get(key) : undefined;
    if (!key || !pos || done.has(key)) continue;
    done.add(key);
    if (el.scrollTop !== pos.top || el.scrollLeft !== pos.left) {
      el.scrollTop = pos.top;
      el.scrollLeft = pos.left;
      moved(el);
    }
    if (pos.bar) bars.push([el, pos.bar]);
  }
  return bars;
}
