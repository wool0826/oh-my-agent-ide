// The command palette (Ctrl/Cmd+K): one list of the places to go and the things to open, narrowed by typing.

export interface PaletteItem {
  /** Unique in the list; the renderer runs the item by it. */
  id: string;
  title: string;
  /** A second line of meta: a Worker's repository and model, a shortcut's owner. Searched too. */
  hint?: string;
  /** Section the item is listed under while nothing is typed. */
  group: string;
  /** The shortcut that does the same, shown at the right. */
  keys?: string;
}

const norm = (s: string) => s.toLowerCase().normalize('NFC');

/**
 * How well an item matches one word, lower is better; null when it does not.
 * 0 the title starts with it, 1 a word of the title starts with it, 2 the title has it, 3 only the hint has it.
 */
function wordRank(title: string, hint: string, word: string): number | null {
  const at = title.indexOf(word);
  if (at === 0) return 0;
  if (at > 0) return /[\s\-_/.:#(]/.test(title[at - 1]) ? 1 : 2;
  return hint.includes(word) ? 3 : null;
}

/**
 * The items that match what was typed, best first. Every word typed has to be in the title or the hint.
 * With nothing typed, the list as it was given. Items of the same rank keep their order.
 */
export function matchItems<T extends Pick<PaletteItem, 'title' | 'hint'>>(items: readonly T[], query: string, limit = 50): T[] {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (!words.length) return items.slice(0, limit);
  const hits: { item: T; rank: number; i: number }[] = [];
  items.forEach((item, i) => {
    const title = norm(item.title);
    const hint = norm(item.hint ?? '');
    let rank = 0;
    for (const w of words) {
      const r = wordRank(title, hint, w);
      if (r === null) return;
      rank += r;
    }
    hits.push({ item, rank, i });
  });
  return hits.sort((a, b) => a.rank - b.rank || a.i - b.i).slice(0, limit).map((h) => h.item);
}

/** The next highlighted row after an arrow key, going round at the ends. */
export function stepIndex(i: number, delta: 1 | -1, count: number): number {
  if (count <= 0) return 0;
  return (i + delta + count) % count;
}
