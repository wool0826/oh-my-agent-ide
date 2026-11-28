// The owner's messages from the phone (decision 250), once TelegramLink has checked who sent them: each update is
// taken once (its id is kept with the state, so one that comes again after a restart is dropped), commands are
// answered here, and words go to the Dispatcher as a turn from the phone. A message older than ten minutes (sent
// while the app was off) waits, kept with the state, until the owner says /run or /drop. The app wires it up in
// remote/wire.ts.
import type { Say } from '../../shared/askWhy';
import { isStale, type TgCallback, type TgMessage, type TgUpdate } from '../../shared/remote';
import { InboundLimit, forwardedBlock, readInbound, type RemoteCommand } from '../../shared/remoteChat';
import { ALBUM_MAX, ALBUM_SETTLE_MS, pickFile, type PickedFile, type TgAttachment } from '../../shared/remoteFile';
import { HELD_DROP, HELD_RUN, answersByReply, readPress, remoteChoices, type TgButton } from '../../shared/remoteDecision';
import type { RemoteLevel } from '../../shared/remoteNotice';
import type { Decision } from '../../shared/types';

/** A message that waits for /run or /drop, with the files it brought (already on the computer). */
export interface HeldMessage { text: string; replyTo: string | null; files?: string[] }

export interface InboundDeps {
  say: Say;
  now(): number;
  /** Words for the Dispatcher, filed under `replyTo` (a task or a chat item); `held`: they wait for a usage limit. */
  toDispatcher(text: string, replyTo: string | null, files: string[]): { held: boolean };
  /** Photos and files from the phone are taken. */
  files(): boolean;
  /** Downloads a file the owner sent and writes it on the computer; its path there. */
  fetchFile(file: TgAttachment): Promise<string>;
  /** Deletes files fetched for messages that will not go (dropped, locked meanwhile, another bot). */
  dropFiles(files: string[]): void;
  /** Stops the Dispatcher's turn; true when one was running. */
  stop(): Promise<boolean>;
  /** Turns requests and answers from the phone off (/lock); only the desktop turns them on again. */
  lock(): void;
  requests(): boolean;
  /** Decisions carry buttons, and a reply to one answers it. */
  buttons(): boolean;
  /** How much the phone is told; a reply answers a decision only where its question was shown. */
  level(): RemoteLevel;
  /** The bot's answer, as a reply to the phone's message, with buttons under it. */
  answer(text: string, replyTo?: number, buttons?: TgButton[][]): void;
  decision(id: string): Pick<Decision, 'id' | 'source' | 'options' | 'status'> | null;
  /** Answers a decision as the user, from the phone. */
  answerDecision(id: string, answer: string): void;
  /** Ends a button press's spinner, with a short note. */
  ack(callbackId: string, text?: string): void;
  /** Takes the buttons off one of the bot's messages. */
  clearButtons(messageId: number): void;
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
  /** The album coming in: its photos and files go to the Dispatcher together once no more arrive. */
  private album: { id: string; text: string[]; files: string[]; to: string | null; msg: number; stale: boolean; timer: NodeJS.Timeout } | null = null;
  /** An album whose first file was refused: the rest of it is passed over without a word. */
  private skipGroup: string | null = null;
  /** Counts forget(): a download that ends after it belongs to the bot before. */
  private gen = 0;

  constructor(private readonly d: InboundDeps) {
    this.stale = d.waiting.load();
  }

  /** Messages that wait for /run or /drop. */
  get held(): number { return this.stale.length; }

  async handle(u: TgUpdate) {
    const m = u.message;
    const c = u.callback_query;
    if ((!m && !c) || this.d.seen.has(u.update_id)) return;
    this.d.seen.add(u.update_id);
    try {
      if (c) await this.press(c);
      else await this.take(m!);
    } finally { this.d.flush(); }
  }

  /** false when past the limit: "too many" is said once (as a reply to `msg`, or on the press). */
  private allow(msg?: number, callback?: string): boolean {
    if (this.limit.allow(this.d.now())) { this.slowTold = false; return true; }
    const text = this.d.say('tg.r.slow');
    if (callback) this.d.ack(callback, text);
    else if (!this.slowTold) this.d.answer(text, msg);
    this.slowTold = true;
    return false;
  }

  /** A press on one of the bot's buttons: a decision's answer, or the held messages' send or drop. */
  private async press(c: TgCallback) {
    const { say } = this.d;
    if (!this.allow(undefined, c.id)) return;
    const p = readPress(c.data);
    const msg = c.message?.message_id;
    let note: string | undefined;
    if (p?.kind === 'held') {
      if (msg !== undefined) this.d.clearButtons(msg);
      await this.command(p.run ? 'run' : 'drop', msg);
    } else if (p?.kind === 'decision') {
      const d = this.d.decision(p.id);
      const choice = d?.status === 'pending' ? remoteChoices(say, d)[p.n] : undefined;
      if (!this.d.buttons()) note = say('tg.r.answersOff');
      else if (!d || !choice) {
        note = say('tg.r.handled');
        if (msg !== undefined) this.d.clearButtons(msg);
      } else {
        this.d.answerDecision(d.id, choice.answer);
        note = choice.label;
      }
    }
    this.d.ack(c.id, note);
  }

  private async take(m: TgMessage) {
    const { say } = this.d;
    const picked = pickFile(m);
    if (picked) return this.takeFile(m, picked);
    const r = readInbound(m);
    // /lock and /stop always go through; everything else, answers included, counts towards the limit.
    const urgent = r.kind === 'command' && (r.name === 'lock' || r.name === 'stop');
    // An album is over once anything else comes; /lock and /stop mean it should not go at all.
    if (this.album) {
      if (urgent) this.dropAlbum();
      else this.sendAlbum();
    }
    if (!urgent && !(r.kind === 'text' && isStale(m.date, this.d.now())) && !this.allow(m.message_id)) return;
    if (r.kind === 'unsupported') return this.d.answer(say('tg.r.unsupported'), m.message_id);
    if (r.kind === 'command') return this.command(r.name, m.message_id);
    const ref = this.d.refOf(m.reply_to_message?.message_id);
    // A reply in the user's own words to a decision still waiting answers it (a permission only on the computer).
    if (ref?.startsWith('d:') && !m.forward_origin && this.d.buttons()) {
      const d = this.d.decision(ref.slice(2));
      if (d?.status === 'pending') {
        if (!answersByReply(d, { level: this.d.level(), stale: isStale(m.date, this.d.now()) })) return this.d.answer(say('tg.r.desktopOnly'), m.message_id);
        return this.d.answerDecision(d.id, r.text);
      }
    }
    if (!this.d.requests()) return this.d.answer(say('tg.r.locked'), m.message_id);
    // A reply to a result or an answer goes into its thread; to a settled decision it is a plain message.
    const to = ref && !ref.startsWith('d:') ? ref : null;
    if (isStale(m.date, this.d.now())) return this.hold(r.text, to);
    this.pass(r.text, to, m.message_id);
  }

  /**
   * A photo or a file, with its caption as the words: it is downloaded at once (Telegram's address for it lasts an
   * hour), then goes as a message would. The photos of one album go together, counted as one message.
   */
  private async takeFile(m: TgMessage, picked: PickedFile) {
    const { say } = this.d;
    const stale = isStale(m.date, this.d.now());
    const group = m.media_group_id;
    if (group && group === this.skipGroup) return;
    const more = !!group && this.album?.id === group;
    if (!more && this.album) this.sendAlbum();
    // One answer for an album: the rest of one refused is passed over.
    const refuse = (key: 'tg.r.locked' | 'tg.r.filesOff' | 'tg.r.tooBig' | 'tg.r.blocked' | 'tg.r.fileFailed') => {
      if (group && !more) this.skipGroup = group;
      this.d.answer(say(key), m.message_id);
    };
    if (!more && !stale && !this.allow(m.message_id)) {
      if (group) this.skipGroup = group;
      return;
    }
    if (!this.d.requests()) return refuse('tg.r.locked');
    if (!this.d.files()) return refuse('tg.r.filesOff');
    if (picked.kind !== 'file') return refuse(picked.kind === 'tooBig' ? 'tg.r.tooBig' : 'tg.r.blocked');
    const gen = this.gen;
    let file: string;
    try {
      file = await this.d.fetchFile(picked.file);
    } catch {
      return refuse('tg.r.fileFailed');
    }
    // Locked, switched off or another bot while it came: it does not go.
    if (gen !== this.gen || !this.d.requests() || !this.d.files()) return this.d.dropFiles([file]);
    const caption = (m.caption ?? '').trim();
    const text = caption && m.forward_origin ? forwardedBlock(caption) : caption;
    const ref = this.d.refOf(m.reply_to_message?.message_id);
    const to = ref && !ref.startsWith('d:') ? ref : null;
    if (group) {
      const a = this.album?.id === group ? this.album : null;
      if (a) {
        clearTimeout(a.timer);
        if (text) a.text.push(text);
        a.files.push(file);
        a.timer = this.albumTimer();
        if (a.files.length >= ALBUM_MAX) this.sendAlbum();
      } else {
        this.album = { id: group, text: text ? [text] : [], files: [file], to, msg: m.message_id, stale, timer: this.albumTimer() };
      }
      return;
    }
    if (stale) return this.hold(text, to, [file]);
    this.pass(text, to, m.message_id, [file]);
  }

  private albumTimer(): NodeJS.Timeout {
    const timer = setTimeout(() => this.sendAlbum(), ALBUM_SETTLE_MS);
    timer.unref?.();
    return timer;
  }

  private dropAlbum() {
    const a = this.album;
    if (!a) return;
    this.album = null;
    clearTimeout(a.timer);
    this.d.dropFiles(a.files);
  }

  private sendAlbum() {
    const a = this.album;
    if (!a) return;
    this.album = null;
    clearTimeout(a.timer);
    const text = a.text.join('\n\n');
    if (a.stale) this.hold(text, a.to, a.files);
    else this.pass(text, a.to, a.msg, a.files);
  }

  /** Hands words to the Dispatcher and says so when they wait; a failure is told, since the update is already taken. */
  private pass(text: string, to: string | null, msg?: number, files: string[] = []): boolean {
    try {
      const { held } = this.d.toDispatcher(text, to, files);
      if (held) this.d.answer(this.d.say('tg.r.held'), msg);
      return held;
    } catch {
      this.d.answer(this.d.say('tg.r.failed'), msg);
      return true;
    }
  }

  private async command(name: RemoteCommand, msg?: number) {
    const { say } = this.d;
    switch (name) {
      case 'status': return this.d.answer(this.d.statusText(), msg);
      case 'inbox': return this.d.answer(this.d.inboxText(), msg);
      case 'start': return this.d.answer(say('tg.msg.connected'), msg);
      case 'help': return this.d.answer(say('tg.r.help'), msg);
      case 'lock':
        if (this.d.requests() || this.d.buttons()) this.d.lock();
        return this.d.answer(say('tg.r.lockedNow'), msg);
      case 'stop':
        if (!this.d.requests()) return this.d.answer(say('tg.r.locked'), msg);
        return this.d.answer(say((await this.d.stop()) ? 'tg.r.stopped' : 'tg.r.idle'), msg);
      case 'drop': {
        const n = this.clearStale(true);
        return this.d.answer(say('tg.r.dropped', { n }), msg);
      }
      case 'run': {
        if (!this.d.requests()) return this.d.answer(say('tg.r.locked'), msg);
        const list = this.stale;
        if (!list.length) return this.d.answer(say('tg.r.noneHeld'), msg);
        this.clearStale();
        // One turn for all of them, in the order they were sent; filed under a thread only when they all were.
        const to = list.every((x) => x.replyTo === list[0].replyTo) ? list[0].replyTo : null;
        const files = list.flatMap((x) => x.files ?? []);
        if (!this.pass(list.map((x) => x.text).filter(Boolean).join('\n\n'), to, msg, files)) this.d.answer(say('tg.r.ran', { n: list.length }), msg);
        return;
      }
    }
  }

  private hold(text: string, replyTo: string | null, files?: string[]) {
    this.stale.push(files?.length ? { text, replyTo, files } : { text, replyTo });
    if (this.stale.length > STALE_MAX) this.stale.shift();
    this.d.waiting.save(this.stale);
    if (this.staleTimer) clearTimeout(this.staleTimer);
    this.staleTimer = setTimeout(() => {
      this.staleTimer = null;
      if (!this.stale.length) return;
      const { say } = this.d;
      this.d.answer(say('tg.r.stale', { n: this.stale.length }), undefined, [[{ text: say('tg.b.run'), data: HELD_RUN }, { text: say('tg.b.drop'), data: HELD_DROP }]]);
    }, STALE_SETTLE_MS);
    this.staleTimer.unref?.();
  }

  /** The bot changed or was disconnected: the waiting messages were its. */
  forget() {
    this.gen++;
    this.dropAlbum();
    this.clearStale(true);
  }

  /** Empties the waiting messages; `drop`: they will not go, so the files they brought are deleted. */
  private clearStale(drop = false): number {
    const n = this.stale.length;
    if (drop) this.d.dropFiles(this.stale.flatMap((x) => x.files ?? []));
    this.stale = [];
    this.d.waiting.save(this.stale);
    if (this.staleTimer) { clearTimeout(this.staleTimer); this.staleTimer = null; }
    return n;
  }
}
