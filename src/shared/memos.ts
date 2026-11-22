// The user's memos: short notes kept in the right sidebar. A memo marked as shared is also given to the Dispatcher.

import type { Memo } from './types';

/** A memo is a note, not a document. */
export const MEMO_MAX = 2000;

/** Text as it is stored: trimmed, line ends normalized, cut at MEMO_MAX. Empty when there is nothing to keep. */
export function cleanMemo(text: unknown): string {
  return String(text ?? '').replace(/\r\n?/g, '\n').trim().slice(0, MEMO_MAX);
}

/** The memos as the sidebar lists them: shared ones and the user's own, each newest first. */
export function memoSections(memos: readonly Memo[]): { shared: Memo[]; mine: Memo[] } {
  const sorted = [...memos].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { shared: sorted.filter((m) => m.shared), mine: sorted.filter((m) => !m.shared) };
}

/**
 * The shared memos for the Dispatcher's system prompt, one bullet each, oldest first so the list is stable
 * as memos are added. Past `maxChars` the oldest are dropped. Empty when nothing is shared.
 */
export function sharedMemoDigest(memos: readonly Memo[], maxChars = 3000): string {
  const lines = memos.filter((m) => m.shared && m.text.trim())
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((m) => `- ${m.text.trim().replace(/\n+/g, '\n  ')}`);
  while (lines.length > 1 && lines.join('\n').length > maxChars) lines.shift();
  return lines.join('\n').slice(0, maxChars);
}
