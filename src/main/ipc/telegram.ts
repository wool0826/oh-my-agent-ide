import { handle } from './handle';
import { telegram } from '../remote/telegramLink';

/** The phone channel's Settings group (decision 241). The token comes in once and never goes back out. */
export function registerTelegramIpc() {
  handle('telegram:token', (token: unknown) => (typeof token === 'string' && token.trim() ? telegram.setToken(token) : telegram.disconnect()));
  handle('telegram:enable', (on: unknown) => telegram.setEnabled(on === true));
  handle('telegram:code', () => telegram.newCode());
  handle('telegram:confirm', () => telegram.confirm());
  handle('telegram:reject', () => telegram.reject());
  handle('telegram:disconnect', () => telegram.disconnect());
  handle('telegram:test', () => telegram.test());
}
