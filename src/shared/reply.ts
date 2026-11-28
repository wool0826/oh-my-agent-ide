// A reply to one message: the quoted message travels at the top of the reply's own text, so the agent reads
// what is being answered and the UI can show it as a quote, with nothing new in the stored shapes.

/**
 * `task`: the reply answers that task's report card, so it is filed under the card (shared/thread.ts).
 * `max`: how much of the quote is sent (default QUOTE_MAX). `icon`: a symbol on the composer's quote card.
 * `src`: the message answered, as the thread names it (`data-src`), so it is ringed while the reply is written.
 * `rerun`: not a reply but a task run again from the composer (4B): the text goes as that task's new request.
 */
export interface Reply { who: string; quote: string; task?: string; max?: number; icon?: string; src?: string; rerun?: { of: string; mode: 'again' | 'copy' } }

/** A quote is a reminder of the message, not a copy of it. */
export const QUOTE_MAX = 280;

/** The message as it is quoted: one line, without its attached-files or mentions block or code fences, cut at QUOTE_MAX. */
export function replyExcerpt(text: string, max = QUOTE_MAX): string {
  const own = (parseReply(text)?.body ?? text).split('\n\n[Attached files]\n')[0].split('\n\n[Mentioned]\n')[0];
  const line = own.replace(/```[\w-]*\n?/g, ' ').replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** A reply kept in a draft on disk (shared/drafts.ts), or null when it is not one. Its own fields only. */
export function readReply(v: unknown): Reply | null {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o.who !== 'string' || typeof o.quote !== 'string') return null;
  const r: Reply = { who: o.who, quote: o.quote };
  for (const k of ['task', 'icon', 'src'] as const) if (typeof o[k] === 'string') r[k] = o[k];
  if (typeof o.max === 'number') r.max = o.max;
  const x = o.rerun as Record<string, unknown> | undefined;
  if (x && typeof x.of === 'string' && (x.mode === 'again' || x.mode === 'copy')) r.rerun = { of: x.of, mode: x.mode };
  return r;
}

/** The text that is sent and stored for a reply. `who` is the author of the quoted message (Dispatcher, W-03). */
export function withReply(reply: Reply | null | undefined, text: string): string {
  if (!reply || !reply.quote.trim()) return text;
  const who = reply.who.replace(/[\]\n]/g, ' ').trim() || 'message';
  return `[Reply to ${who}]\n> ${replyExcerpt(reply.quote, reply.max)}\n\n${text}`;
}

/** The quote at the top of a message written with withReply, and the message under it. Null for any other text. */
export function parseReply(text: string): (Reply & { body: string }) | null {
  const m = /^\[Reply to ([^\]\n]+)\]\n> ([^\n]*)\n\n?([\s\S]*)$/.exec(text);
  return m ? { who: m[1], quote: m[2], body: m[3] } : null;
}
