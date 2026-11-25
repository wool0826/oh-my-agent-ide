// A turn Claude Code starts by itself for a comment someone sent to Claude on a claude.ai artifact (T-0084, F1).
//
// Claude Code puts the comment into the conversation as a user-role message it adds itself, headed
// "[Artifact comment sent to Claude]", and the Agent SDK emits it on the output stream like a tool result: a `user`
// message with no parent tool call. The SDK gives no origin kind for it, so the heading is what tells it apart. Only
// the heading is relied on; the comment's words and the artifact's link are read loosely from what follows.

import type { Say } from './askWhy';

const HEAD = /\[Artifact comment sent to Claude\]/i;
const ARTIFACT_URL = /https:\/\/claude\.ai\/(?:code\/)?artifacts?\/[\w-]+/;
/** Lines that are the relay's own labels rather than the comment: ids, threads, links. */
const META = /^(?:[-*]\s*)?(?:artifact|url|link|thread|comment[_ ]?id|id|from|author|by|on)\s*[:=]/i;

export interface ArtifactComment {
  /** The comment's first words, on one line. */
  excerpt: string;
  /** The artifact's link, when the message has one. */
  url: string | null;
}

/** The text of a user-role message: a string, or its text blocks. Tool results are not text. */
export function userMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}

/** The comment a message carries, or null when it is not an artifact comment turn. */
export function parseArtifactComment(text: string): ArtifactComment | null {
  const at = text.search(HEAD);
  if (at < 0) return null;
  const rest = text.slice(at).replace(HEAD, '');
  const url = rest.match(ARTIFACT_URL)?.[0] ?? null;
  // A "Comment:" label, when there is one, holds the words; otherwise the first line that is not a label or a link.
  const labeled = rest.match(/(?:^|\n)\s*(?:[-*]\s*)?(?:comment|text|body|message)\s*:\s*(.+)/i)?.[1];
  const line = labeled ?? rest.split('\n').map((l) => l.trim()).find((l) => l && !META.test(l) && !ARTIFACT_URL.test(l) && !/^[;\w-]+=/.test(l)) ?? '';
  const words = line.replace(/^["“'”]+|["“'”]+$/g, '').replace(/\s+/g, ' ').trim();
  return { excerpt: words.length > 80 ? `${words.slice(0, 79)}…` : words, url };
}

/**
 * Whether a tool call posts a reply to a comment: ArtifactComments with `action: "reply"` and words in `text` (its
 * schema; read, resolve and watch post nothing).
 */
export function writesComment(name: string, input: unknown): boolean {
  if (name !== 'ArtifactComments' || !input || typeof input !== 'object') return false;
  const o = input as Record<string, unknown>;
  return o.action === 'reply' && typeof o.text === 'string' && o.text.trim() !== '';
}

/**
 * The conversation's event line for a comment turn: when it comes in, the comment's first words and the artifact's
 * link; when it ends, whether a reply was posted.
 */
export function artifactCommentLine(say: Say, e: { phase: 'start' | 'end'; comment: ArtifactComment; replied: boolean }): string {
  if (e.phase === 'end') return say(e.replied ? 'ev.artReplied' : 'ev.artNoReply');
  const head = e.comment.excerpt ? say('ev.artComment', { text: e.comment.excerpt }) : say('ev.artCommentBare');
  return e.comment.url ? `${head} · ${e.comment.url}` : head;
}
