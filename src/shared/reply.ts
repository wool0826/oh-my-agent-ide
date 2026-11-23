// A reply to one message: the quoted message travels at the top of the reply's own text, so the agent reads
// what is being answered and the UI can show it as a quote, with nothing new in the stored shapes.

/** `task`: the reply answers that task's report card, so it is filed under the card (shared/thread.ts). */
export interface Reply { who: string; quote: string; task?: string }

/** A quote is a reminder of the message, not a copy of it. */
export const QUOTE_MAX = 280;

/** The message as it is quoted: one line, without its attached-files block or code fences, cut at QUOTE_MAX. */
export function replyExcerpt(text: string, max = QUOTE_MAX): string {
  const own = (parseReply(text)?.body ?? text).split('\n\n[Attached files]\n')[0];
  const line = own.replace(/```[\w-]*\n?/g, ' ').replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** The text that is sent and stored for a reply. `who` is the author of the quoted message (Dispatcher, W-03). */
export function withReply(reply: Reply | null | undefined, text: string): string {
  if (!reply || !reply.quote.trim()) return text;
  const who = reply.who.replace(/[\]\n]/g, ' ').trim() || 'message';
  return `[Reply to ${who}]\n> ${replyExcerpt(reply.quote)}\n\n${text}`;
}

/** The quote at the top of a message written with withReply, and the message under it. Null for any other text. */
export function parseReply(text: string): (Reply & { body: string }) | null {
  const m = /^\[Reply to ([^\]\n]+)\]\n> ([^\n]*)\n\n?([\s\S]*)$/.exec(text);
  return m ? { who: m[1], quote: m[2], body: m[3] } : null;
}
