// The quick message box's typing aids: finishing an @repository name, and going back through what was sent (decision 135).

export interface RepoCompletion {
  /** The repository the word under the caret would become. */
  repo: string;
  /** The text and caret once it is taken. */
  text: string;
  caret: number;
}

/**
 * The repository an "@word" ending at the caret is the start of, or null: no such word, no repository starting
 * with it, or the name already typed in full. Of several, the shortest name wins, then the first registered.
 */
export function completeRepo(text: string, caret: number, repos: readonly string[]): RepoCompletion | null {
  const before = text.slice(0, caret);
  const m = /(^|\s)@([\w.-]*)$/.exec(before);
  if (!m) return null;
  const typed = m[2].toLowerCase();
  const fits = repos.filter((r) => r.toLowerCase().startsWith(typed) && r.toLowerCase() !== typed);
  if (!fits.length) return null;
  const repo = fits.reduce((a, b) => (b.length < a.length ? b : a));
  const start = before.length - m[2].length;
  const after = text.slice(caret);
  const gap = after.startsWith(' ') || !after ? (after ? '' : ' ') : ' ';
  const next = `${text.slice(0, start)}${repo}${gap}${after}`;
  return { repo, text: next, caret: start + repo.length + (after.startsWith(' ') ? 1 : gap.length) };
}

export const RECENT_MAX = 10;

/** The list of sent lines with a new one in front; the same line is kept once. */
export function addRecent(list: readonly string[], line: string, max = RECENT_MAX): string[] {
  const v = line.trim();
  if (!v) return [...list];
  return [v, ...list.filter((x) => x !== v)].slice(0, max);
}

/**
 * Going through the sent lines with the arrow keys. `at` is the place in the list (-1: the line being typed).
 * Up goes to older lines and stops at the oldest; Down comes back and ends at the line being typed.
 */
export function recentStep(count: number, at: number, dir: 'up' | 'down'): number {
  if (dir === 'up') return Math.min(count - 1, at + 1);
  return Math.max(-1, at - 1);
}

// The composers' prompt history (decision 1B): what was sent to the Dispatcher or to one Worker, opened with Up.

/** One prompt sent from a composer. */
export interface SentPrompt {
  text: string;
  /** When it was last sent, ISO. */
  at: string;
}

/** Prompts kept per composer target; the list scrolls past what fits. */
export const HISTORY_MAX = 50;

/** The history key of a composer target: the Dispatcher's chat, or one Worker by id. */
export function historyKey(worker: string | null | undefined): string {
  return worker ? `w:${worker}` : 'chat';
}

/** The history with a prompt sent now in front; the same text is kept once, at its newest time. */
export function addSent(list: readonly SentPrompt[], text: string, at: string, max = HISTORY_MAX): SentPrompt[] {
  const v = text.trim();
  if (!v) return [...list];
  return [{ text: v, at }, ...list.filter((x) => x.text !== v)].slice(0, max);
}

/** Up opens the history only from an empty composer, so it never takes the caret's move up a line of text. */
export function opensHistory(value: string): boolean {
  return value.trim() === '';
}

/** A part of a row's text, marked where it matches what is typed. */
export type MatchPart = { text: string; hit: boolean };

/** The prompts holding what is typed, case aside, newest first; nothing typed keeps them all. */
export function filterSent(list: readonly SentPrompt[], query: string): SentPrompt[] {
  const q = query.trim().toLowerCase();
  return q ? list.filter((x) => x.text.toLowerCase().includes(q)) : [...list];
}

/** A row's text cut where it matches what is typed, for bold matches. Only the first line of a prompt is shown. */
export function matchParts(text: string, query: string): MatchPart[] {
  const line = text.split('\n')[0];
  const q = query.trim().toLowerCase();
  if (!q) return [{ text: line, hit: false }];
  const out: MatchPart[] = [];
  const low = line.toLowerCase();
  let from = 0;
  for (let i = low.indexOf(q); i >= 0; i = low.indexOf(q, from)) {
    if (i > from) out.push({ text: line.slice(from, i), hit: false });
    out.push({ text: line.slice(i, i + q.length), hit: true });
    from = i + q.length;
  }
  if (from < line.length) out.push({ text: line.slice(from), hit: false });
  return out;
}

/** How long ago a prompt went, as a row shows it: just now, minutes or hours under a day, yesterday, then M/D. */
export type SentAge = { kind: 'now' } | { kind: 'min' | 'hour'; n: number } | { kind: 'yesterday' } | { kind: 'date'; month: number; day: number };

export function sentAge(at: string, now: Date): SentAge {
  const d = new Date(at);
  const m = Math.max(0, Math.floor((now.getTime() - d.getTime()) / 60000));
  // An unreadable time reads as now rather than as a date of nothing.
  if (!(m >= 1)) return { kind: 'now' };
  if (m < 60) return { kind: 'min', n: m };
  const day = (x: Date) => Date.UTC(x.getFullYear(), x.getMonth(), x.getDate()) / 86_400_000;
  const days = day(now) - day(d);
  if (days === 0 || m < 6 * 60) return { kind: 'hour', n: Math.floor(m / 60) };
  if (days === 1) return { kind: 'yesterday' };
  return { kind: 'date', month: d.getMonth() + 1, day: d.getDate() };
}
