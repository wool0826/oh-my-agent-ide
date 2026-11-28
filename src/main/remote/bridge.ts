// The app's news to the phone (decision 246): what the rules in shared/remoteNotice.ts let through goes into one
// queue, which sends a message a second at most, waits out a 429, retries a failed send with back-off and drops it
// after a few tries. Nothing waits here while Telegram is off, unpaired or its token refused.
import { log } from '../log';
import { t } from '../i18n';
import { loadSettings } from '../settings';
import { Burst, inQuietHours } from '../../shared/notifyRules';
import { backoffMs, splitText } from '../../shared/remote';
import { SendQueue, newsEvent, newsGroup, newsKey, newsRef, newsText, type Outgoing, type RemoteNews, type RemotePrefs } from '../../shared/remoteNotice';
import { SentRefs } from '../../shared/remoteChat';
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

/** 429s in a row for one message before it is dropped. */
const RATE_TRIES = 10;

export class Outbox {
  readonly queue = new SendQueue();
  /** What each message sent is about, so a reply to it on the phone finds its thread (remote/inbound.ts). */
  readonly sent = new SentRefs();
  /** Ids for the bot's own answers, each its own message. */
  private answers = 0;
  private bursts = new Burst();
  private running = false;
  private lastSent = 0;
  private fails = 0;
  private rates = 0;
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
    const added = this.queue.add({ key: newsKey(n), group, text: newsText(this.say, n, p.level), silent, urgent: n.type === 'decision', ref: newsRef(n) }, at);
    if (added) this.kick();
    return added;
  }

  /**
   * The bot's own answer to a message from the phone (a command, a turned-away request), as a reply to it. It goes
   * whatever kinds of news are switched on; false when the channel is not ready.
   */
  answer(text: string, replyTo?: number): boolean {
    if (!this.ch.ready) return false;
    const key = `answer:${++this.answers}`;
    const added = this.queue.add({ key, group: key, text, silent: false, urgent: true, replyTo }, this.now());
    if (added) this.kick();
    return added;
  }

  /** Waiting messages are dropped (the channel was turned off or disconnected). */
  clear() { this.queue.clear(); this.fails = 0; this.rates = 0; }

  /** Resolves when nothing waits and nothing is on its way (for tests). */
  async idle() { while (this.running || this.queue.size) await new Promise((r) => setTimeout(r, 5)); }

  private kick() {
    if (this.running) return;
    this.running = true;
    void this.pump().catch((e) => log.warn('telegram outbox', (e as Error).message)).finally(() => {
      this.running = false;
      // News told while the loop was ending would otherwise wait for the next one.
      if (this.queue.size && this.ch.ready) this.kick();
    });
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
      // Switched off or disconnected during the gap: nothing more goes.
      if (!this.ch.ready) { this.queue.forget(o); this.clear(); return; }
      const wait = await this.sendOne(o);
      if (wait === null) continue;
      this.queue.retry(o);
      await this.pause(wait);
      if (!this.ch.ready) { this.clear(); return; }
    }
  }

  /** null: sent or given up; a number: how long to wait before trying it again. */
  private async sendOne(o: Outgoing): Promise<number | null> {
    try {
      // The bot sends plain text; long news goes in up to three parts.
      let first = true;
      for (const part of splitText(o.text)) {
        const id = await this.ch.send(part, { silent: o.silent, replyTo: first ? o.replyTo : undefined });
        first = false;
        this.lastSent = this.now();
        if (o.ref) this.sent.add(id, o.ref);
      }
      this.fails = 0;
      this.rates = 0;
      return null;
    } catch (e) {
      this.lastSent = this.now();
      const err = e instanceof TelegramError ? e : null;
      log.warn('telegram send', err ? `${err.kind} ${err.code}` : 'failed');
      if (err?.kind === 'rate' && ++this.rates <= RATE_TRIES) return (err.retryAfter ?? 1) * 1000;
      // A refused token, a message Telegram will never take, or one it keeps refusing for speed: no retry. A refused token shows as invalid.
      if (!err || err.kind === 'auth' || err.kind === 'bad' || err.kind === 'rate') { if (err?.kind === 'auth') this.clear(); else this.queue.forget(o); this.fails = 0; this.rates = 0; return null; }
      this.fails++;
      if (this.fails >= this.tries) { this.queue.forget(o); this.fails = 0; return null; }
      return this.backoff(this.fails);
    }
  }
}

export const outbox = new Outbox(telegram);

/** Tells the phone, when Telegram is on and paired; never throws. */
export function tellRemote(n: RemoteNews) {
  try { outbox.tell(n); } catch (e) { log.warn('telegram tell', (e as Error).message); }
}
