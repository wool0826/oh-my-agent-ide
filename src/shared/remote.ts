// Rules for the phone channel (Telegram, decision 241): splitting long text, hiding the bot token, the pairing code
// that binds the bot to its owner's chat, which updates count, and how long to wait before trying again.
// Pure: the Bot API client is src/main/remote/telegramApi.ts, the polling loop src/main/remote/telegram.ts.

/** The longest text one Telegram message may carry. */
export const TG_TEXT_MAX = 4096;

/** What the channel shows in Settings, next to the group's title. */
export type RemoteStatus = 'off' | 'token' | 'pairing' | 'connected' | 'retrying' | 'invalid' | 'elsewhere';

/** The parts of a Bot API update the app reads. The client checks the shape (telegramApi.ts). */
export interface TgUser { id: number; is_bot?: boolean; first_name?: string; last_name?: string; username?: string }
export interface TgChat { id: number; type: string }
export interface TgMessage { message_id: number; date: number; chat: TgChat; from?: TgUser; text?: string }
export interface TgUpdate { update_id: number; message?: TgMessage }

/**
 * Text cut into messages of at most `max` characters, at a paragraph break, else a line break, else a space, else
 * anywhere. More than `parts` pieces: the last kept one ends with `more` (such as "see the rest on the desktop").
 */
export function splitText(text: string, max = TG_TEXT_MAX, parts = 3, more = '…'): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest && out.length < parts) {
    if (rest.length <= max) { out.push(rest); rest = ''; break; }
    const head = rest.slice(0, max);
    const cut = [head.lastIndexOf('\n\n'), head.lastIndexOf('\n'), head.lastIndexOf(' ')].find((i) => i > max / 2) ?? safeCut(rest, max);
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest && out.length) {
    const tail = `\n${more}`;
    const last = out[out.length - 1];
    out[out.length - 1] = (last.length + tail.length > max ? last.slice(0, safeCut(last, max - tail.length)) : last) + tail;
  }
  return out;
}

/** `at`, or one less when that would split an emoji (a surrogate pair) in two. */
function safeCut(s: string, at: number): number {
  const c = s.charCodeAt(at - 1);
  return c >= 0xd800 && c <= 0xdbff ? at - 1 : at;
}

/** A Bot API token: the bot's number, a colon, and its secret. */
const TOKEN = /\d{5,}:[A-Za-z0-9_-]{30,}/g;

/** Does this read as a bot token from BotFather? */
export function looksLikeToken(s: string): boolean {
  return new RegExp(`^${TOKEN.source}$`).test(s.trim());
}

/** Text with every bot token in it replaced, so an error or a log line never carries one. */
export function maskToken(s: string): string {
  return s.replace(TOKEN, '<token>').replace(/\/bot[^/\s]+\//g, '/bot<token>/');
}

/** Letters a person reads off a screen without mixing them up: no 0/O or 1/I. 32 of them, so a byte maps evenly. */
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const PAIR_LEN = 8;
export const PAIR_TTL_MS = 10 * 60_000;
export const PAIR_TRIES = 5;

/** A pairing code from random bytes (crypto.randomBytes in the app). */
export function makePairCode(bytes: Uint8Array): string {
  if (bytes.length < PAIR_LEN) throw new Error('need more random bytes');
  return Array.from(bytes.slice(0, PAIR_LEN), (b) => CODE_LETTERS[b & 31]).join('');
}

/** The code as shown: two groups of four. */
export function showPairCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** The code as typed or sent: capitals and digits only, so "k7q2-9fxm" matches. */
export function normPairCode(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Equal strings, in a time that does not depend on where they differ. */
export function sameSecret(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/** The bot link that opens a chat and sends `/start <code>` for the user. */
export function pairLink(botName: string, code: string): string {
  return `https://t.me/${encodeURIComponent(botName)}?start=${code}`;
}

/** The code in `/start CODE`, `/start@my_bot CODE`, or a message that is only the code; else null. */
export function pairCodeIn(text: string | undefined): string | null {
  const t = (text ?? '').trim();
  const m = t.match(/^\/start(?:@\w+)?\s+(\S+)$/i);
  const code = normPairCode(m ? m[1] : t);
  return code.length === PAIR_LEN && (m || /^[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}$/.test(t)) ? code : null;
}

export interface Pairing { code: string; expiresAt: number; tries: number }
/** Who sent the right code: the desktop shows them and the user confirms before they become the owner. */
export interface PairCandidate { id: number; name: string }

/**
 * One update while a code is open. Only a person's private chat counts, and only a message sent after the code was
 * made (`openedAt`, ms). A wrong code costs a try; after the last one, or once it expires, the code is gone.
 */
export function checkPair(p: Pairing | null, u: TgUpdate, openedAt: number, now: number):
  { pairing: Pairing | null; result: 'match' | 'wrong' | 'ignore'; who?: PairCandidate } {
  if (!p || now >= p.expiresAt) return { pairing: null, result: 'ignore' };
  const m = u.message;
  if (!m || m.chat.type !== 'private' || !m.from || m.from.is_bot || m.from.id !== m.chat.id) return { pairing: p, result: 'ignore' };
  if (m.date * 1000 < openedAt - 5_000) return { pairing: p, result: 'ignore' };
  const code = pairCodeIn(m.text);
  if (code && sameSecret(code, p.code)) return { pairing: null, result: 'match', who: { id: m.from.id, name: personName(m.from) } };
  // Only a message that tries a code costs a try, so "hi" or a bare /start does not burn the code.
  if (!code && !/^\/start(?:@\w+)?\s+\S/i.test(m.text ?? '')) return { pairing: p, result: 'ignore' };
  const tries = p.tries + 1;
  return { pairing: tries >= PAIR_TRIES ? null : { ...p, tries }, result: 'wrong' };
}

/** A Telegram user as shown: their name, else @username, else the number. */
export function personName(u: TgUser): string {
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ').trim();
  return name || (u.username ? `@${u.username}` : String(u.id));
}

/** Is this update from the owner, in their private chat with the bot? Anything else is dropped without a reply. */
export function fromOwner(u: TgUpdate, ownerId: number | null): boolean {
  const m = u.message;
  return !!m && ownerId !== null && m.chat.type === 'private' && m.from?.id === ownerId && m.chat.id === ownerId;
}

/**
 * The update ids handled lately, so one that comes again (the app stopped before Telegram heard it was read) is
 * dropped. A list, not "lower than the last", because Telegram may start ids over after a quiet week.
 */
export class Seen {
  private ids: number[] = [];
  constructor(private size = 200) {}
  /** True the first time an id is seen; false after. */
  add(id: number): boolean {
    if (this.ids.includes(id)) return false;
    this.ids.push(id);
    if (this.ids.length > this.size) this.ids.shift();
    return true;
  }
}

/** Was this message (Telegram `date`, seconds) sent more than `maxMs` before `now` (ms)? */
export function isStale(dateSec: number, now: number, maxMs = 10 * 60_000): boolean {
  return now - dateSec * 1000 > maxMs;
}

/** How long to wait before try number `attempt` (1, 2, …) after a failure: 1 s doubling, at most a minute. */
export function backoffMs(attempt: number, base = 1_000, max = 60_000): number {
  return Math.min(max, base * 2 ** Math.max(0, attempt - 1));
}

/** How many conflicts (another getUpdates on the same token) in a row mean another PC is using the bot. */
export const CONFLICTS_ELSEWHERE = 3;

/** What settings.json keeps about the bot besides its encrypted token (`telegramTokenEnc`). Never sent to the page as is. */
export interface TelegramStored {
  enabled: boolean;
  botId: number | null;
  botName: string | null;
  ownerId: number | null;
  ownerName: string | null;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) ? v : null);
const str = (v: unknown) => (typeof v === 'string' && v ? v.slice(0, 200) : null);

/** The stored part, from whatever a hand-edited settings.json holds. Off until the user turns it on. */
export function cleanTelegram(raw: unknown): TelegramStored {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const ownerId = num(r.ownerId);
  return { enabled: r.enabled === true, botId: num(r.botId), botName: str(r.botName), ownerId, ownerName: ownerId === null ? null : str(r.ownerName) };
}

/** What Settings shows about the channel: no token, no secret, only whether one is stored. */
export interface TelegramView {
  enabled: boolean;
  status: RemoteStatus;
  tokenSet: boolean;
  bot: string | null;
  /** The open pairing code, its end (ms) and its bot link; null when none is open. */
  code: string | null;
  codeEnds: number | null;
  link: string | null;
  /** Who sent the right code and waits for the desktop to confirm them. */
  candidate: PairCandidate | null;
  owner: PairCandidate | null;
}

/** What the poller or the last send said, if anything went wrong. */
export type RemoteTrouble = 'retrying' | 'invalid' | 'elsewhere' | null;

/** The status chip: off, then a missing token, then trouble, then pairing, else connected. */
export function remoteStatus(a: { enabled: boolean; tokenSet: boolean; ownerId: number | null; trouble: RemoteTrouble }): RemoteStatus {
  if (!a.enabled) return 'off';
  if (!a.tokenSet) return 'token';
  if (a.trouble) return a.trouble;
  return a.ownerId === null ? 'pairing' : 'connected';
}

/** The time left on a code as m:ss, never below 0:00. */
export function codeLeft(ends: number, now: number): string {
  const s = Math.max(0, Math.ceil((ends - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
