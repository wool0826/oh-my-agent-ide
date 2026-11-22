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
