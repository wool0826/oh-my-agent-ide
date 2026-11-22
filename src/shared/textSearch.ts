// Searching what was said: the chat with the Dispatcher and Workers' conversations (decision 134).

/** The words of a query, lower-cased. Every one has to be in a text for it to match. */
export function searchWords(query: string): string[] {
  return query.toLowerCase().normalize('NFC').split(/\s+/).filter(Boolean);
}

export function textMatches(text: string, words: readonly string[]): boolean {
  if (!words.length) return false;
  const t = text.toLowerCase().normalize('NFC');
  return words.every((w) => t.includes(w));
}

/** One line of the text around the first word found, with … where it was cut. */
export function snippet(text: string, words: readonly string[], radius = 48): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const low = flat.toLowerCase();
  let at = -1;
  for (const w of words) { const i = low.indexOf(w); if (i >= 0 && (at < 0 || i < at)) at = i; }
  if (at < 0) return flat.slice(0, radius * 2) + (flat.length > radius * 2 ? '…' : '');
  const start = Math.max(0, at - radius);
  const end = Math.min(flat.length, at + radius);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

export interface TextHit {
  /** The Dispatcher chat, or a Worker's conversation by its id. */
  where: 'chat' | string;
  /** chat: the item's id. A Worker's conversation: the line's number in its log. */
  id: string;
  ts: string;
  snippet: string;
}

/** The newest `limit` items that match, newest first. */
export function searchItems<T extends { ts: string; text: string }>(items: readonly T[], query: string, limit: number, key: (x: T, index: number) => string, where: string): TextHit[] {
  const words = searchWords(query);
  const out: TextHit[] = [];
  for (let i = items.length - 1; i >= 0 && out.length < limit; i--) {
    const x = items[i];
    if (textMatches(x.text, words)) out.push({ where, id: key(x, i), ts: x.ts, snippet: snippet(x.text, words) });
  }
  return out;
}

/** Shorter than this, a query would match nearly everything said. */
export const SEARCH_MIN = 2;
