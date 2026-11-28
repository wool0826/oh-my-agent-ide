// The Telegram Bot API over plain fetch (decision 241): no library, nothing listening, only calls out to
// api.telegram.org. The token sits in the address, so no error, log line or thrown message here ever carries it:
// every failure becomes "method: code description" with any token shape masked.
import { z } from 'zod';
import { maskToken, type TgUpdate, type TgUser } from '../../shared/remote';
import type { TgButton } from '../../shared/remoteDecision';
import { fileUrlPath } from '../../shared/remoteFile';

/** The API's address; tests point it at a stand-in server with OMA_TELEGRAM_API, as OMA_DATA_DIR moves the data. */
export const telegramBase = () => (process.env.OMA_TELEGRAM_API || 'https://api.telegram.org').replace(/\/+$/, '');

/** What went wrong, sorted by what the caller does next. */
export type TgErrorKind = 'auth' | 'conflict' | 'rate' | 'bad' | 'server' | 'network';

export class TelegramError extends Error {
  constructor(readonly method: string, readonly kind: TgErrorKind, readonly code: number | null, description: string, readonly retryAfter: number | null = null) {
    super(maskToken(`${method}: ${code ?? kind} ${description}`.trim()));
    this.name = 'TelegramError';
  }
}

const user = z.object({ id: z.number(), is_bot: z.boolean().optional(), first_name: z.string().optional(), last_name: z.string().optional(), username: z.string().optional() });
const message = z.object({
  message_id: z.number(),
  date: z.number(),
  chat: z.object({ id: z.number(), type: z.string() }),
  from: user.optional(),
  text: z.string().optional(),
  forward_origin: z.object({ type: z.string() }).optional(),
  reply_to_message: z.object({ message_id: z.number() }).optional(),
  photo: z.array(z.object({ file_id: z.string(), width: z.number().optional(), height: z.number().optional(), file_size: z.number().optional() })).optional(),
  document: z.object({ file_id: z.string(), file_name: z.string().optional(), mime_type: z.string().optional(), file_size: z.number().optional() }).optional(),
  caption: z.string().optional(),
  media_group_id: z.string().optional(),
});
const fileInfo = z.object({ file_id: z.string(), file_size: z.number().optional(), file_path: z.string().optional() });
const callback = z.object({
  id: z.string(),
  from: user,
  message: z.object({ message_id: z.number(), chat: z.object({ id: z.number(), type: z.string() }) }).optional(),
  data: z.string().optional(),
});
const update = z.object({ update_id: z.number(), message: message.optional(), callback_query: callback.optional() });
const reply = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  error_code: z.number().optional(),
  description: z.string().optional(),
  parameters: z.object({ retry_after: z.number().optional() }).optional(),
});

/**
 * Which answers mean what. A refused token gives 401, or 404 for one that is not a token at all; a 404 without
 * Telegram's own reply (a proxy, a wrong OMA_TELEGRAM_API) is not about the token.
 */
function kindOf(status: number, telegram = true): TgErrorKind {
  if (status === 401 || (status === 404 && telegram)) return 'auth';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate';
  if (status >= 500) return 'server';
  return 'bad';
}

export interface CallOpts { timeoutMs?: number; signal?: AbortSignal }
export interface SendOpts { silent?: boolean; replyTo?: number; buttons?: TgButton[][] }

const keyboard = (rows: TgButton[][]) => ({ inline_keyboard: rows.map((r) => r.map((b) => ({ text: b.text, callback_data: b.data }))) });

export class TelegramApi {
  constructor(private readonly token: string, private readonly base = telegramBase()) {}

  /** One Bot API method with JSON parameters; its `result` checked against `schema`. */
  async call<T>(method: string, params: Record<string, unknown>, schema: z.ZodType<T>, o: CallOpts = {}): Promise<T> {
    const timeout = AbortSignal.timeout(o.timeoutMs ?? 20_000);
    const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
    let res: Response;
    try {
      // redirect: 'error' keeps the token in the address from following a redirect to another host.
      res = await fetch(`${this.base}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        redirect: 'error',
        signal,
      });
    } catch (e) {
      // fetch's own message can quote the address; only its name is kept.
      throw new TelegramError(method, 'network', null, o.signal?.aborted ? 'aborted' : timeout.aborted ? 'timed out' : (e as Error).name || 'failed');
    }
    const body = reply.safeParse(await res.json().catch(() => null));
    if (!body.success) throw new TelegramError(method, res.ok ? 'bad' : kindOf(res.status, false), res.status, 'unreadable reply');
    if (!res.ok || !body.data.ok) {
      const code = body.data.error_code ?? res.status;
      throw new TelegramError(method, kindOf(code), code, body.data.description ?? '', body.data.parameters?.retry_after ?? null);
    }
    const result = schema.safeParse(body.data.result);
    if (!result.success) throw new TelegramError(method, 'bad', res.status, 'unexpected result');
    return result.data;
  }

  /** The bot this token belongs to. */
  getMe(o?: CallOpts): Promise<TgUser & { username: string }> {
    return this.call('getMe', {}, user.extend({ username: z.string() }), o);
  }

  /**
   * Updates after `offset`, waiting up to `timeout` seconds for one (long polling). Asking with an offset tells
   * Telegram the ones before it were read, so they do not come again.
   */
  getUpdates(offset: number | null, timeout: number, o: CallOpts = {}): Promise<TgUpdate[]> {
    const params: Record<string, unknown> = { timeout, allowed_updates: ['message', 'callback_query'] };
    if (offset !== null) params.offset = offset;
    // The request waits on the server, so it may take longer than the poll itself.
    // Each update is checked on its own: one the app cannot read comes back as its id alone, so the poller still
    // moves past it instead of asking for it for ever.
    const list = z.array(z.object({ update_id: z.number() }).passthrough());
    return this.call('getUpdates', params, list, { ...o, timeoutMs: o.timeoutMs ?? (timeout + 15) * 1000 })
      .then((us) => us.map((u) => { const r = update.safeParse(u); return r.success ? r.data : { update_id: u.update_id }; }));
  }

  /**
   * Plain text to a chat: no Markdown or HTML, so text from a Worker cannot hide one address behind another, and no
   * link preview, so Telegram's servers do not fetch a private repository's address.
   */
  sendMessage(chatId: number, text: string, s: SendOpts = {}, o?: CallOpts): Promise<{ message_id: number }> {
    const params: Record<string, unknown> = { chat_id: chatId, text, link_preview_options: { is_disabled: true } };
    if (s.silent) params.disable_notification = true;
    if (s.replyTo) params.reply_parameters = { message_id: s.replyTo, allow_sending_without_reply: true };
    if (s.buttons?.length) params.reply_markup = keyboard(s.buttons);
    return this.call('sendMessage', params, message.pick({ message_id: true }), o);
  }

  /** Takes the buttons off one of the bot's messages, and with `text` puts that text in its place. */
  async editMessage(chatId: number, messageId: number, text: string | null, o?: CallOpts): Promise<void> {
    const base = { chat_id: chatId, message_id: messageId, reply_markup: keyboard([]) };
    if (text === null) await this.call('editMessageReplyMarkup', base, z.unknown(), o);
    else await this.call('editMessageText', { ...base, text, link_preview_options: { is_disabled: true } }, z.unknown(), o);
  }

  /**
   * A file sent to the bot, as bytes: Telegram gives its path (getFile), then its address under /file serves it. More
   * than `max` bytes, said or counted while it comes, stops the download ('bad': it will never fit).
   */
  async download(fileId: string, max: number, o: CallOpts = {}): Promise<Uint8Array> {
    const info = await this.call('getFile', { file_id: fileId }, fileInfo, o);
    const where = fileUrlPath(info.file_path ?? '');
    if (!where) throw new TelegramError('getFile', 'bad', null, 'no file path');
    if ((info.file_size ?? 0) > max) throw new TelegramError('getFile', 'bad', null, 'too big');
    const timeout = AbortSignal.timeout(o.timeoutMs ?? 120_000);
    const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetch(`${this.base}/file/bot${this.token}/${where}`, { redirect: 'error', signal });
    } catch (e) {
      throw new TelegramError('file', 'network', null, timeout.aborted ? 'timed out' : (e as Error).name || 'failed');
    }
    if (!res.ok || !res.body) { await res.body?.cancel().catch(() => {}); throw new TelegramError('file', kindOf(res.status, false), res.status, ''); }
    if (Number(res.headers.get('content-length') ?? 0) > max) { await res.body.cancel().catch(() => {}); throw new TelegramError('file', 'bad', res.status, 'too big'); }
    const parts: Uint8Array[] = [];
    let size = 0;
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > max) { await reader.cancel().catch(() => {}); throw new TelegramError('file', 'bad', res.status, 'too big'); }
        parts.push(value);
      }
    } catch (e) {
      if (e instanceof TelegramError) throw e;
      throw new TelegramError('file', 'network', null, timeout.aborted ? 'timed out' : (e as Error).name || 'failed');
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.byteLength; }
    return out;
  }

  /** Ends a button press's spinner, with a short note shown over the chat. */
  async answerCallbackQuery(id: string, text?: string, o?: CallOpts): Promise<void> {
    const params: Record<string, unknown> = { callback_query_id: id };
    if (text) params.text = text.slice(0, 200);
    await this.call('answerCallbackQuery', params, z.unknown(), o);
  }
}
