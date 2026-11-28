import { handle } from './handle';
import { telegram } from '../remote/telegramLink';
import { REMOTE_EVENTS, type RemoteEvent } from '../../shared/remoteNotice';

/** The phone channel's Settings group (decision 245). The token comes in once and never goes back out. */
export function registerTelegramIpc() {
  handle('telegram:token', (token: unknown) => telegram.setToken(typeof token === 'string' ? token : ''));
  handle('telegram:enable', (on: unknown) => telegram.setEnabled(on === true));
  handle('telegram:code', () => telegram.newCode());
  handle('telegram:confirm', () => telegram.confirm());
  handle('telegram:reject', () => telegram.reject());
  handle('telegram:disconnect', () => telegram.disconnect());
  handle('telegram:test', () => telegram.test());
  // One kind of news on or off ({ event, on }), or how much is sent ({ level }); anything else is ignored.
  handle('telegram:prefs', (p: unknown) => {
    const r = (p && typeof p === 'object' ? p : {}) as { event?: unknown; on?: unknown; level?: unknown; requests?: unknown; buttons?: unknown };
    if (typeof r.event === 'string' && typeof r.on === 'boolean' && (REMOTE_EVENTS as readonly string[]).includes(r.event)) telegram.setPrefs({ events: { [r.event as RemoteEvent]: r.on } });
    if (r.level === 'title' || r.level === 'summary') telegram.setPrefs({ level: r.level });
    if (typeof r.requests === 'boolean') telegram.setPrefs({ requests: r.requests });
    if (typeof r.buttons === 'boolean') telegram.setPrefs({ buttons: r.buttons });
  });
}
