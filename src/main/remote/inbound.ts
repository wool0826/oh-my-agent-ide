// The owner's messages from the phone (decision 250), once TelegramLink has checked who sent them: each update is
// taken once (its id is kept with the state, so one that comes again after a restart is dropped), commands are
// answered here, and words go to the Dispatcher as a turn from the phone. A message older than ten minutes (sent
// while the app was off) waits, kept with the state, until the owner says /run or /drop. The app wires it up in
// remote/wire.ts.
import type { Say } from '../../shared/askWhy';
import { isStale, type TgMessage, type TgUpdate } from '../../shared/remote';
import { InboundLimit, readInbound, type RemoteCommand } from '../../shared/remoteChat';

/** A message that waits for /run or /drop. */
export interface HeldMessage { text: string; replyTo: string | null }

export interface InboundDeps {
  say: Say;
  now(): number;
  /** Words for the Dispatcher, filed under `replyTo` (a task or a chat item); `held`: they wait for a usage limit. */
  toDispatcher(text: string, replyTo: string | null): { held: boolean };
  /** Stops the Dispatcher's turn; true when one was running. */
  stop(): Promise<boolean>;
  /** Turns requests from the phone off (/lock); only the desktop turns them on again. */
  lock(): void;
  requests(): boolean;
  /** The bot's answer, as a reply to the phone's message. */
  answer(text: string, replyTo?: number): void;
  /** What the bot's message with this id was about (remoteNotice newsRef), if it is still known. */
  refOf(messageId: number | undefined): string | null;
  statusText(): string;
  inboxText(): string;
  /** The update ids already taken, kept with the state. */
  seen: { has(id: number): boolean; add(id: number): void };
  /** The messages waiting for /run or /drop, kept with the state so a restart does not lose them. */
  waiting: { load(): HeldMessage[]; save(list: HeldMessage[]): void };
  /** Writes the state now, so the chat line and the update's id are on disk before Telegram hears it was read. */
  flush(): void;
}

/** Messages sent while the app was off that wait at most; past it the oldest goes. */
const STALE_MAX = 20;
/** Held messages come together (one getUpdates brings them all): the question about them goes once they settle. */
const STALE_SETTLE_MS = 1_500;

export class Inbound {
  private limit = new InboundLimit();
  /** "Too many" is said once until a message goes through again. */
  private slowTold = false;
  private stale: HeldMessage[];
  private staleTimer: NodeJS.Timeout | null = null;

  constructor(private readonly d: InboundDeps) {
    this.stale = d.waiting.load();
  }

  /** Messages that wait for /run or /drop. */
  get held(): number { return this.stale.length; }

  async handle(u: TgUpdate) {
    const m = u.message;
    if (!m || this.d.seen.has(u.update_id)) return;
    this.d.seen.add(u.update_id);
    try { await this.take(m); } finally { this.d.flush(); }
  }

  private async take(m: TgMessage) {
    const { say } = this.d;
    const r = readInbound(m);
    // /lock and /stop always go through; everything else, answers included, counts towards the limit.
    const urgent = r.kind === 'command' && (r.name === 'lock' || r.name === 'stop');
    if (!urgent && !(r.kind === 'text' && isStale(m.date, this.d.now()))) {
      if (!this.limit.allow(this.d.now())) {
        if (!this.slowTold) this.d.answer(say('tg.r.slow'), m.message_id);
        this.slowTold = true;
        return;
      }
      this.slowTold = false;
    }
    if (r.kind === 'unsupported') return this.d.answer(say('tg.r.unsupported'), m.message_id);
    if (r.kind === 'command') return this.command(r.name, m.message_id);
    if (!this.d.requests()) return this.d.answer(say('tg.r.locked'), m.message_id);
    // A reply to a result or an answer goes into its thread; to a decision it is a plain message for now.
    const ref = this.d.refOf(m.reply_to_message?.message_id);
    const to = ref && !ref.startsWith('d:') ? ref : null;
    if (isStale(m.date, this.d.now())) return this.hold(r.text, to);
    this.pass(r.text, to, m.message_id);
  }

  /** Hands words to the Dispatcher and says so when they wait; a failure is told, since the update is already taken. */
  private pass(text: string, to: string | null, msg: number): boolean {
    try {
      const { held } = this.d.toDispatcher(text, to);
      if (held) this.d.answer(this.d.say('tg.r.held'), msg);
      return held;
    } catch {
      this.d.answer(this.d.say('tg.r.failed'), msg);
      return true;
    }
  }

  private async command(name: RemoteCommand, msg: number) {
    const { say } = this.d;
    switch (name) {
      case 'status': return this.d.answer(this.d.statusText(), msg);
      case 'inbox': return this.d.answer(this.d.inboxText(), msg);
      case 'start': return this.d.answer(say('tg.msg.connected'), msg);
      case 'help': return this.d.answer(say('tg.r.help'), msg);
      case 'lock':
        if (this.d.requests()) this.d.lock();
        return this.d.answer(say('tg.r.lockedNow'), msg);
      case 'stop':
        if (!this.d.requests()) return this.d.answer(say('tg.r.locked'), msg);
        return this.d.answer(say((await this.d.stop()) ? 'tg.r.stopped' : 'tg.r.idle'), msg);
      case 'drop': {
        const n = this.clearStale();
        return this.d.answer(say('tg.r.dropped', { n }), msg);
      }
      case 'run': {
        if (!this.d.requests()) return this.d.answer(say('tg.r.locked'), msg);
        const list = this.stale;
        if (!list.length) return this.d.answer(say('tg.r.noneHeld'), msg);
        this.clearStale();
        // One turn for all of them, in the order they were sent; filed under a thread only when they all were.
        const to = list.every((x) => x.replyTo === list[0].replyTo) ? list[0].replyTo : null;
        if (!this.pass(list.map((x) => x.text).join('\n\n'), to, msg)) this.d.answer(say('tg.r.ran', { n: list.length }), msg);
        return;
      }
    }
  }

  private hold(text: string, replyTo: string | null) {
    this.stale.push({ text, replyTo });
    if (this.stale.length > STALE_MAX) this.stale.shift();
    this.d.waiting.save(this.stale);
    if (this.staleTimer) clearTimeout(this.staleTimer);
    this.staleTimer = setTimeout(() => {
      this.staleTimer = null;
      if (this.stale.length) this.d.answer(this.d.say('tg.r.stale', { n: this.stale.length }));
    }, STALE_SETTLE_MS);
    this.staleTimer.unref?.();
  }

  /** The bot changed or was disconnected: the waiting messages were its. */
  forget() { this.clearStale(); }

  private clearStale(): number {
    const n = this.stale.length;
    this.stale = [];
    this.d.waiting.save(this.stale);
    if (this.staleTimer) { clearTimeout(this.staleTimer); this.staleTimer = null; }
    return n;
  }
}
