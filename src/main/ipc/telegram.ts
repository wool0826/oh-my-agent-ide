import { handle } from './handle';
import { telegram } from '../remote/telegramLink';

/** The phone channel's Settings group (decision 244). The token comes in once and never goes back out. */
export function registerTelegramIpc() {
  handle('telegram:token', (token: unknown) => telegram.setToken(typeof token === 'string' ? token : ''));
  handle('telegram:enable', (on: unknown) => telegram.setEnabled(on === true));
  handle('telegram:code', () => telegram.newCode());
  handle('telegram:confirm', () => telegram.confirm());
  handle('telegram:reject', () => telegram.reject());
  handle('telegram:disconnect', () => telegram.disconnect());
  handle('telegram:test', () => telegram.test());
}
