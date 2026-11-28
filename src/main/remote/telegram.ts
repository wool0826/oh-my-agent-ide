// Long polling for Telegram updates (decision 241): one getUpdates at a time, each update handed on once, waits
// that grow after a failure, and a stop on a refused token or on another poller of the same bot.
import { CONFLICTS_ELSEWHERE, Seen, backoffMs, type TgUpdate } from '../../shared/remote';
import { TelegramError, type TelegramApi } from './telegramApi';

/** What the loop reports: working, failing and trying again, or stopped for good until the user acts. */
export type PollState = 'ok' | 'retrying' | 'invalid' | 'elsewhere';

export interface PollerOpts {
  onUpdate: (u: TgUpdate) => void | Promise<void>;
  onState: (s: PollState, err?: TelegramError) => void;
  /** Seconds one getUpdates waits on the server. */
  timeoutSec?: number;
  /** The wait before try `n` after a failure; tests make it short. */
  backoff?: (n: number) => number;
  /** Where an earlier poller of the same bot stopped, so what it handled is not asked for again. */
  offset?: number | null;
}

/** A wait that ends early when `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => { clearTimeout(t); signal.removeEventListener('abort', done); resolve(); };
    const t = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

export class TelegramPoller {
  private ctl: AbortController | null = null;
  private loop: Promise<void> | null = null;
  private offset: number | null = null;
  private seen = new Seen();

  constructor(private readonly api: TelegramApi, private readonly o: PollerOpts) {
    this.offset = o.offset ?? null;
  }

  get running(): boolean { return !!this.ctl; }
  /** The offset the next getUpdates sends: one past the last update handed on. */
  get nextOffset(): number | null { return this.offset; }

  start() {
    if (this.ctl) return;
    const ctl = new AbortController();
    this.ctl = ctl;
    this.loop = this.run(ctl.signal).catch(() => { /* a throwing onState must not leave a rejection behind */ }).finally(() => { if (this.ctl === ctl) this.ctl = null; });
  }

  /** Stops the loop and waits until its last request has ended. */
  async stop() {
    const loop = this.loop;
    this.ctl?.abort();
    this.ctl = null;
    this.loop = null;
    await loop;
  }

  private async run(signal: AbortSignal) {
    let fails = 0, conflicts = 0, state: PollState | null = null;
    // 'ok' is told once after a failure (or at the start); every failure is told.
    const report = (s: PollState, err?: TelegramError) => {
      if (s === 'ok' && state === 'ok') return;
      state = s;
      try { this.o.onState(s, err); } catch { /* the listener logs its own failures */ }
    };
    while (!signal.aborted) {
      let updates: TgUpdate[];
      try {
        updates = await this.api.getUpdates(this.offset, this.o.timeoutSec ?? 50, { signal });
      } catch (e) {
        if (signal.aborted) break;
        const err = e instanceof TelegramError ? e : new TelegramError('getUpdates', 'network', null, 'failed');
        if (err.kind === 'auth') { report('invalid', err); break; }
        conflicts = err.kind === 'conflict' ? conflicts + 1 : 0;
        // Another poller on this token. The app's own last request from before a restart can hold it for one poll,
        // so it takes a few in a row.
        if (conflicts >= CONFLICTS_ELSEWHERE) { report('elsewhere', err); break; }
        fails++;
        report('retrying', err);
        // retry_after is capped, so a wild value cannot park the loop for hours.
        await pause(err.kind === 'rate' && err.retryAfter ? Math.min(err.retryAfter, 300) * 1000 : (this.o.backoff ?? backoffMs)(fails), signal);
        continue;
      }
      fails = 0;
      conflicts = 0;
      report('ok');
      for (const u of updates) {
        if (signal.aborted) return;
        // Asked for next time even when the handler throws: one bad update must not come back for ever.
        // Ids far below the last one: Telegram started them over after a quiet week, so the old list means nothing.
        if (this.offset !== null && u.update_id < this.offset - 1_000) this.seen = new Seen();
        this.offset = u.update_id + 1;
        if (!this.seen.add(u.update_id)) continue;
        try { await this.o.onUpdate(u); } catch { /* the handler logs its own failures */ }
      }
    }
  }
}
