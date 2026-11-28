// A stand-in for the Telegram Bot API on 127.0.0.1 (decision 241), as gh-stub.mjs stands in for gh. The app talks to
// it through OMA_TELEGRAM_API. It knows one bot token, holds getUpdates open until an update comes (long polling),
// answers an older getUpdates with 409 when a newer one arrives, as Telegram does, and can be told to fail.
import http from 'node:http';

export const STUB_TOKEN = '123456789:AAEhBP0av18q1wQ7stubstubstubstubstub';

/**
 * Starts the server. `state.sent` has every message the app sent, `state.calls` every method called.
 * `push(update)` queues an update (update_id is filled in), `failNext(method, status, description, extra)` makes the
 * next call to that method fail, `user(id, text)` builds a private-chat message update from that user.
 */
export async function startTelegramStub({ token = STUB_TOKEN, bot = { id: 123456789, is_bot: true, first_name: 'Stub', username: 'stub_bot' } } = {}) {
  const state = { sent: [], calls: [], updates: [], nextId: 1, nextMessage: 1, token, bot, fails: new Map(), waiting: null, edits: [], acks: [] };

  const reply = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const ok = (res, result) => reply(res, 200, { ok: true, result });
  const err = (res, status, description, extra = {}) => reply(res, status, { ok: false, error_code: status, description, ...extra });

  const pending = (offset) => {
    // An offset confirms everything before it, so those are gone for good. Ids far below it are a new run, as
    // Telegram starts after a quiet week, and stay.
    if (offset != null) state.updates = state.updates.filter((u) => u.update_id >= offset || u.update_id < offset - 1_000);
    return state.updates;
  };
  const wake = () => {
    const w = state.waiting;
    if (!w || !state.updates.length) return;
    state.waiting = null;
    clearTimeout(w.timer);
    ok(w.res, pending(w.offset));
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const m = req.url.match(/^\/bot([^/]+)\/(\w+)$/);
      if (!m) return err(res, 404, 'Not Found');
      const [, tok, method] = m;
      let p;
      try { p = raw ? JSON.parse(raw) : {}; } catch { return err(res, 400, 'Bad Request: invalid JSON'); }
      state.calls.push({ method, params: p });
      if (tok !== state.token) return err(res, 401, 'Unauthorized');
      const fail = state.fails.get(method);
      if (fail?.length) {
        const f = fail.shift();
        return err(res, f.status, f.description, f.extra);
      }
      switch (method) {
        case 'getMe': return ok(res, state.bot);
        case 'getUpdates': {
          if (state.waiting) {
            const old = state.waiting;
            state.waiting = null;
            clearTimeout(old.timer);
            err(old.res, 409, 'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running');
          }
          const list = pending(p.offset);
          if (list.length || !p.timeout) return ok(res, list);
          const w = { res, offset: p.offset, timer: setTimeout(() => { if (state.waiting === w) { state.waiting = null; ok(res, []); } }, p.timeout * 1000) };
          state.waiting = w;
          // The app gave up on this request (it stopped polling): forget it.
          res.on('close', () => { if (state.waiting === w) { clearTimeout(w.timer); state.waiting = null; } });
          return;
        }
        case 'sendMessage': {
          if (!p.text) return err(res, 400, 'Bad Request: message text is empty');
          if (p.text.length > 4096) return err(res, 400, 'Bad Request: message is too long');
          const msg = { message_id: state.nextMessage++, date: Math.floor(Date.now() / 1000), chat: { id: p.chat_id, type: 'private' }, text: p.text };
          state.sent.push({ ...p, message_id: msg.message_id });
          return ok(res, msg);
        }
        case 'editMessageText':
        case 'editMessageReplyMarkup':
          state.edits.push({ method, ...p });
          return ok(res, true);
        case 'answerCallbackQuery':
          state.acks.push(p);
          return ok(res, true);
        default: return err(res, 404, 'Not Found: method not found');
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;

  return {
    url,
    token,
    state,
    push(update) {
      const u = { update_id: state.nextId++, ...update };
      state.updates.push(u);
      wake();
      return u;
    },
    user(id, text, { date = Math.floor(Date.now() / 1000), type = 'private', name = 'Owner' } = {}) {
      return { message: { message_id: state.nextMessage++, date, chat: { id: type === 'private' ? id : -id, type }, from: { id, is_bot: false, first_name: name }, text } };
    },
    /** A press on a button under the bot's message `messageId`, by user `id` in their private chat. */
    press(id, messageId, data) {
      return { callback_query: { id: `cb${state.nextId}`, from: { id, is_bot: false, first_name: 'Owner' }, message: { message_id: messageId, chat: { id, type: 'private' } }, data } };
    },
    failNext(method, status, description, extra = {}, times = 1) {
      const list = state.fails.get(method) ?? [];
      for (let i = 0; i < times; i++) list.push({ status, description, extra });
      state.fails.set(method, list);
    },
    /** Revokes the token, as /revoke in BotFather does: every later call gets 401. */
    revoke() { state.token = `${state.token}x`; },
    close() {
      if (state.waiting) { clearTimeout(state.waiting.timer); state.waiting.res.destroy(); state.waiting = null; }
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
