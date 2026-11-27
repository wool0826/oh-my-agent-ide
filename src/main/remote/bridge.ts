// The app's news to the phone (decision 246): what the rules in shared/remoteNotice.ts let through goes into one
// queue, which sends a message a second at most, waits out a 429, retries a failed send with back-off and drops it
// after a few tries. Nothing waits here while Telegram is off, unpaired or its token refused.
import { log } from '../log';
import { t } from '../i18n';
import { loadSettings } from '../settings';
import { Burst, inQuietHours } from '../../shared/notifyRules';
import { backoffMs, splitText } from '../../shared/remote';
import { SendQueue, newsEvent, newsGroup, newsKey, newsText, type Outgoing, type RemoteNews, type RemotePrefs } from '../../shared/remoteNotice';
import type { Say } from '../../shared/askWhy';
import type { SendOpts } from './telegramApi';
import { TelegramError } from './telegramApi';
import { telegram } from './telegramLink';

/** What the outbox needs of the link; TelegramLink in the app, a stand-in in tests. */
export interface Channel {
  readonly ready: boolean;
  prefs(): RemotePrefs;
  send(text: string, o?: SendOpts): Promise<number>;
}

export interface OutboxOpts {
  say?: Say;
  /** Do-not-disturb hours are on now: messages go without a sound. */
  quiet?: () => boolean;
  /** At least this long between two messages (Telegram allows about one a second to one chat). */
  gapMs?: number;
  /** Tries for a message that fails on the network or Telegram's side before it is dropped. */
  tries?: number;
  backoff?: (n: number) => number;
  now?: () => number;
}

export class Outbox {
  readonly queue = new SendQueue();
  private bursts = new Burst();
  private running = false;
  private lastSent = 0;
  private fails = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly say: Say;
  private readonly quiet: () => boolean;
  private readonly gapMs: number;
  private readonly tries: number;
  private readonly backoff: (n: number) => number;
  private readonly now: () => number;

  constructor(private readonly ch: Channel, o: OutboxOpts = {}) {
    this.say = o.say ?? t;
    this.quiet = o.quiet ?? (() => { const s = loadSettings(); return inQuietHours(s.quietFrom, s.quietTo, new Date()); });
    this.gapMs = o.gapMs ?? 1_000;
    this.tries = o.tries ?? 5;
    this.backoff = o.backoff ?? ((n) => backoffMs(n));
    this.now = o.now ?? Date.now;
  }

  /** Queues the news when the channel is paired and its kind is switched on; false when it is not sent. */
  tell(n: RemoteNews): boolean {
    if (!this.ch.ready) return false;
    const p = this.ch.prefs();
    if (!p.events[newsEvent(n)]) return false;
    const group = newsGroup(n);
    const at = this.now();
    const silent = this.quiet() || !this.bursts.allow(group, at);
    const added = this.queue.add({ key: newsKey(n), group, text: newsText(this.say, n, p.level), silent, urgent: n.type === 'decision' }, at);
    if (added) this.kick();
    return added;
  }

  /** Waiting messages are dropped (the channel was turned off or disconnected). */
  clear() { this.queue.clear(); this.fails = 0; }

  /** Resolves when nothing waits and nothing is on its way (for tests). */
  async idle() { while (this.running || this.queue.size) await new Promise((r) => setTimeout(r, 5)); }

  private kick() {
    if (this.running) return;
    this.running = true;
    void this.pump().catch((e) => log.warn('telegram outbox', (e as Error).message)).finally(() => { this.running = false; });
  }

  private pause(ms: number) {
    return new Promise<void>((r) => {
      this.timer = setTimeout(() => { this.timer = null; r(); }, Math.max(0, ms));
      this.timer.unref?.();
    });
  }

  private async pump() {
    for (let o = this.queue.next(); o; o = this.queue.next()) {
      if (!this.ch.ready) { this.clear(); return; }
      await this.pause(this.lastSent + this.gapMs - this.now());
      const wait = await this.sendOne(o);
      if (wait === null) continue;
      this.queue.retry(o);
      await this.pause(wait);
    }
  }

  /** null: sent or given up; a number: how long to wait before trying it again. */
  private async sendOne(o: Outgoing): Promise<number | null> {
    try {
      // The bot sends plain text; long news goes in up to three parts.
      for (const part of splitText(o.text)) { await this.ch.send(part, { silent: o.silent }); this.lastSent = this.now(); }
      this.fails = 0;
      return null;
    } catch (e) {
      this.lastSent = this.now();
      const err = e instanceof TelegramError ? e : null;
      log.warn('telegram send', err ? `${err.kind} ${err.code}` : 'failed');
      if (err?.kind === 'rate') return (err.retryAfter ?? 1) * 1000;
      // A refused token or a message Telegram will never take: no retry. The link shows the token as invalid.
      if (!err || err.kind === 'auth' || err.kind === 'bad') { if (err?.kind === 'auth') this.clear(); this.fails = 0; return null; }
      this.fails++;
      if (this.fails >= this.tries) { this.fails = 0; return null; }
      return this.backoff(this.fails);
    }
  }
}

export const outbox = new Outbox(telegram);

/** Tells the phone, when Telegram is on and paired; never throws. */
export function tellRemote(n: RemoteNews) {
  try { outbox.tell(n); } catch (e) { log.warn('telegram tell', (e as Error).message); }
}
