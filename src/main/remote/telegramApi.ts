// The Telegram Bot API over plain fetch (decision 241): no library, nothing listening, only calls out to
// api.telegram.org. The token sits in the address, so no error, log line or thrown message here ever carries it:
// every failure becomes "method: code description" with any token shape masked.
import { z } from 'zod';
import { maskToken, type TgUpdate, type TgUser } from '../../shared/remote';

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
});
const update = z.object({ update_id: z.number(), message: message.optional() });
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
export interface SendOpts { silent?: boolean; replyTo?: number }

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
    const params: Record<string, unknown> = { timeout, allowed_updates: ['message'] };
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
    return this.call('sendMessage', params, message.pick({ message_id: true }), o);
  }
}
