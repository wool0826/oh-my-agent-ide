// The Telegram bot as the app holds it (decision 245): its token encrypted with safeStorage, the pairing that binds
// it to the owner's private chat, and its status. Polling runs while a pairing code is open, and once paired while
// requests from the phone are on (decision 250): then only the owner's private messages are handed on, the rest
// dropped unanswered. Nothing here logs or returns the token, and no message text goes to the log.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { safeStorage } from 'electron';
import { loadSettings, saveSettings } from '../settings';
import { log } from '../log';
import { t } from '../i18n';
import {
  PAIR_TTL_MS, checkPair, cleanTelegram, fromOwner, looksLikeToken, makePairCode, pairLink, remoteStatus,
  type PairCandidate, type Pairing, type RemoteTrouble, type TelegramStored, type TelegramView, type TgUpdate,
} from '../../shared/remote';
import { cleanPrefs, type RemoteEvent, type RemoteLevel, type RemotePrefs } from '../../shared/remoteNotice';
import { TelegramApi, TelegramError, type SendOpts } from './telegramApi';
import { TelegramPoller, type PollState } from './telegram';

/** Where the token and the bot's record live; settings.json by default, a stand-in in tests. */
export interface LinkStore {
  load(): { tokenEnc: string; cfg: TelegramStored };
  save(tokenEnc: string, cfg: TelegramStored): void;
}

/** Strict encryption: unlike encryptToken in settings.ts there is no plain fallback, so no safeStorage means no token. */
export interface LinkCrypt {
  available(): boolean;
  encrypt(s: string): string;
  decrypt(s: string): string;
}

const settingsStore: LinkStore = {
  load() { const s = loadSettings(); return { tokenEnc: s.telegramTokenEnc ?? '', cfg: cleanTelegram(s.telegram) }; },
  save(tokenEnc, cfg) { const s = loadSettings(); s.telegramTokenEnc = tokenEnc; s.telegram = cfg; saveSettings(); },
};

const safeCrypt: LinkCrypt = {
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: (s) => `enc:${safeStorage.encryptString(s).toString('base64')}`,
  decrypt: (s) => (s.startsWith('enc:') ? safeStorage.decryptString(Buffer.from(s.slice(4), 'base64')) : ''),
};

/** An error for the page: the client's own text is already free of the token. */
function userError(e: unknown): Error {
  if (e instanceof TelegramError) return new Error(e.kind === 'auth' ? t('tg.err.auth') : t('tg.err.reach', { msg: e.message }));
  return e instanceof Error ? e : new Error(String(e));
}

export class TelegramLink extends EventEmitter {
  private api: TelegramApi | null = null;
  private poller: TelegramPoller | null = null;
  private pairing: Pairing | null = null;
  private openedAt = 0;
  private candidate: PairCandidate | null = null;
  private trouble: RemoteTrouble = null;
  private expiry: NodeJS.Timeout | null = null;
  /** Bumped by every change of token, switch or pairing: a token check that comes back after one is dropped. */
  private gen = 0;
  /** Where the last poller stopped: the next one goes on from there instead of reading the same updates again. */
  private offset: number | null = null;
  /** Updates dropped because they were not the owner's private messages (counted, never read). */
  dropped = 0;
  /** What handles the owner's messages once paired (remote/inbound.ts); none, and nothing is polled for them. */
  inbound: ((u: TgUpdate) => void | Promise<void>) | null = null;
  /** Called when the bot changes or is disconnected: what was kept about its updates no longer applies. */
  onForget: (() => void) | null = null;
  /** A stop under way: a poller started meanwhile waits for it, or Telegram sees two getUpdates (409). */
  private stopping: Promise<void> | null = null;

  constructor(private readonly store: LinkStore = settingsStore, private readonly crypt: LinkCrypt = safeCrypt, private readonly base?: string, private readonly pollSec = 50) {
    super();
  }

  private get cfg(): TelegramStored { return this.store.load().cfg; }

  private token(): string {
    const enc = this.store.load().tokenEnc;
    if (!enc) return '';
    try { return this.crypt.decrypt(enc); } catch { return ''; }
  }

  private client(): TelegramApi | null {
    if (!this.api) { const tok = this.token(); if (tok) this.api = new TelegramApi(tok, this.base); }
    return this.api;
  }

  private changed() { this.emit('changed'); }

  private setTrouble(tr: RemoteTrouble) {
    if (tr === this.trouble) return;
    const was = this.trouble;
    this.trouble = tr;
    // Told once when the token stops working, so the chat can say it.
    if (tr === 'invalid' && was !== 'invalid') this.emit('invalid');
    this.changed();
  }

  /** Is the bot paired and its token working, so messages can go? */
  get ready(): boolean {
    const c = this.cfg;
    return c.enabled && c.ownerId !== null && this.trouble !== 'invalid' && !!this.client();
  }

  view(): TelegramView {
    const c = this.cfg;
    const tokenSet = !!this.store.load().tokenEnc;
    const code = this.pairing && !this.candidate ? this.pairing.code : null;
    return {
      enabled: c.enabled,
      status: remoteStatus({ enabled: c.enabled, tokenSet, ownerId: c.ownerId, trouble: this.trouble }),
      tokenSet,
      bot: c.botName,
      code,
      codeEnds: code ? this.pairing!.expiresAt : null,
      link: code && c.botName ? pairLink(c.botName, code) : null,
      candidate: this.candidate,
      owner: c.ownerId === null ? null : { id: c.ownerId, name: c.ownerName ?? String(c.ownerId) },
      prefs: c.prefs,
    };
  }

  /** What is sent and how much. */
  prefs(): RemotePrefs { return this.cfg.prefs; }

  /** Turns one kind of news on or off, sets how much is sent, or whether the phone's messages are taken. */
  setPrefs(patch: { events?: Partial<Record<RemoteEvent, boolean>>; level?: RemoteLevel; requests?: boolean; buttons?: boolean; files?: boolean }) {
    const c = this.cfg;
    const prefs = cleanPrefs({
      events: { ...c.prefs.events, ...patch.events }, level: patch.level ?? c.prefs.level,
      requests: patch.requests ?? c.prefs.requests, buttons: patch.buttons ?? c.prefs.buttons, files: patch.files ?? c.prefs.files,
    });
    this.store.save(this.store.load().tokenEnc, { ...c, prefs });
    this.syncPoll();
    this.changed();
  }

  /** At launch: with a paired bot, check once that the token still works. */
  async init() {
    const c = this.cfg;
    if (!c.enabled || c.ownerId === null || !this.client()) return;
    try { await this.client()!.getMe(); this.setTrouble(null); } catch (e) { this.noteFailure(e); }
    this.syncPoll();
  }

  /** Checks a new token with Telegram, then stores it encrypted. A different bot drops the old pairing. */
  async setToken(raw: string) {
    const tok = raw.trim();
    if (!looksLikeToken(tok)) throw new Error(t('tg.err.token'));
    if (!this.crypt.available()) throw new Error(t('tg.err.noCrypto'));
    const gen = ++this.gen;
    const api = new TelegramApi(tok, this.base);
    const me = await api.getMe().catch((e) => { throw userError(e); });
    // Disconnected, switched or given another token meanwhile: that came later and wins.
    if (gen !== this.gen) return;
    await this.halt();
    const c = this.cfg;
    const same = c.botId === me.id;
    const next: TelegramStored = { ...c, botId: me.id, botName: me.username, ownerId: same ? c.ownerId : null, ownerName: same ? c.ownerName : null };
    this.store.save(this.crypt.encrypt(tok), next);
    this.api = api;
    if (!same) { this.offset = null; this.onForget?.(); }
    this.trouble = null;
    log.info('telegram token saved', { bot: me.username, kept: same && next.ownerId !== null });
    if (next.enabled && next.ownerId === null) this.newCode();
    else this.syncPoll();
    this.changed();
  }

  async setEnabled(on: boolean) {
    const c = this.cfg;
    if (c.enabled === on) return;
    this.gen++;
    this.store.save(this.store.load().tokenEnc, { ...c, enabled: on });
    if (!on) await this.halt();
    else if (c.ownerId === null && this.client()) this.newCode();
    else void this.init();
    this.changed();
  }

  /** Opens a new pairing code for 10 minutes and polls for it. */
  newCode() {
    const api = this.client();
    const c = this.cfg;
    if (!api || !c.enabled || c.ownerId !== null) throw new Error(t('tg.err.notReady'));
    this.candidate = null;
    this.openedAt = Date.now();
    this.pairing = { code: makePairCode(crypto.randomBytes(8)), expiresAt: this.openedAt + PAIR_TTL_MS, tries: 0 };
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = setTimeout(() => { this.pairing = null; this.syncPoll(); this.changed(); }, PAIR_TTL_MS);
    this.expiry.unref?.();
    this.startPolling(api);
    this.changed();
  }

  /** Is there something to read: an open code, or the owner's messages or button presses while either is on? */
  private wantsPoll(): boolean {
    if (this.pairing && !this.candidate) return true;
    const c = this.cfg;
    return c.enabled && c.ownerId !== null && (c.prefs.requests || c.prefs.buttons) && !!this.inbound && this.trouble !== 'invalid' && this.trouble !== 'elsewhere';
  }

  /** Starts or stops polling to match wantsPoll. Never waits, so a handler of an update may call it. */
  syncPoll() {
    const api = this.client();
    if (api && this.wantsPoll()) this.startPolling(api);
    else if (this.poller) void this.stopPolling();
  }

  private startPolling(api: TelegramApi) {
    if (!this.poller && this.stopping) {
      void this.stopping.then(() => this.syncPoll());
      return;
    }
    if (!this.poller) this.poller = new TelegramPoller(api, { onUpdate: (u) => this.onUpdate(u), onState: (s) => this.onPoll(s), timeoutSec: this.pollSec, offset: this.offset });
    this.poller.start();
  }

  private onPoll(s: PollState) {
    this.setTrouble(s === 'ok' ? null : s);
    if (s === 'invalid' || s === 'elsewhere') { this.pairing = null; this.poller = null; this.changed(); }
  }

  private async onUpdate(u: TgUpdate) {
    // Ids and sizes only: the text may be anyone's.
    log.info('telegram update', { id: u.update_id, kind: u.message ? 'message' : 'other', len: u.message?.text?.length ?? 0 });
    if (!this.pairing) {
      const c = this.cfg;
      if (c.ownerId === null || !this.inbound) return;
      // Anyone but the owner in their private chat with the bot: no answer, so the bot gives nothing away.
      if (!fromOwner(u, c.ownerId)) { this.dropped++; log.info('telegram dropped', { id: u.update_id, n: this.dropped }); return; }
      await this.inbound(u);
      return;
    }
    if (this.candidate) return;
    const r = checkPair(this.pairing, u, this.openedAt, Date.now());
    this.pairing = r.pairing;
    if (r.result === 'match') {
      this.candidate = r.who!;
      // Kept until the desktop says yes or no; nothing else needs reading meanwhile.
      this.pairing = { code: '', expiresAt: Date.now() + PAIR_TTL_MS, tries: 0 };
      void this.stopPolling();
    } else if (!this.pairing) this.syncPoll();
    if (r.result !== 'ignore') log.info('telegram pairing', { result: r.result, left: this.pairing ? 'open' : 'closed' });
    this.changed();
  }

  /** The user confirmed the person who sent the code: they become the owner, and the bot says hello. */
  async confirm() {
    const who = this.candidate;
    if (!who) return;
    this.candidate = null;
    this.pairing = null;
    if (this.expiry) { clearTimeout(this.expiry); this.expiry = null; }
    this.store.save(this.store.load().tokenEnc, { ...this.cfg, ownerId: who.id, ownerName: who.name });
    log.info('telegram paired');
    this.syncPoll();
    this.changed();
    await this.send(t('tg.msg.connected')).catch((e) => log.warn('telegram hello', (e as Error).message));
  }

  /** Not the right person: forget them and open a fresh code. */
  reject() {
    this.candidate = null;
    this.pairing = null;
    this.newCode();
  }

  /** Forgets the token, the bot and its owner. The token stays valid at Telegram until it is revoked in BotFather. */
  async disconnect() {
    this.gen++;
    await this.halt();
    const c = this.cfg;
    this.store.save('', { ...cleanTelegram(null), enabled: c.enabled, prefs: c.prefs });
    this.api = null;
    this.offset = null;
    this.trouble = null;
    this.onForget?.();
    log.info('telegram disconnected');
    this.changed();
  }

  /** One message to the owner. Throws an error fit for the page; a refused token marks the link invalid. */
  async send(text: string, o: SendOpts = {}): Promise<number> {
    const c = this.cfg;
    const api = this.client();
    if (!api || !c.enabled || c.ownerId === null) throw new Error(t('tg.err.notReady'));
    try {
      const r = await api.sendMessage(c.ownerId, text, o);
      if (this.trouble === 'invalid' || this.trouble === 'retrying') this.setTrouble(null);
      return r.message_id;
    } catch (e) {
      this.noteFailure(e);
      throw e instanceof TelegramError ? e : userError(e);
    }
  }

  /** Takes the buttons off one of the bot's messages to the owner, and with `text` changes its text. */
  async edit(messageId: number, text: string | null): Promise<void> {
    const c = this.cfg;
    const api = this.client();
    if (!api || !c.enabled || c.ownerId === null) throw new Error(t('tg.err.notReady'));
    try { await api.editMessage(c.ownerId, messageId, text); } catch (e) { this.noteFailure(e); throw e; }
  }

  /** A file the owner sent, as bytes, at most `max` of them. */
  async download(fileId: string, max: number): Promise<Uint8Array> {
    const api = this.client();
    if (!api || !this.cfg.enabled || this.cfg.ownerId === null) throw new Error(t('tg.err.notReady'));
    try { return await api.download(fileId, max); } catch (e) { this.noteFailure(e); throw e; }
  }

  /** Ends a button press's spinner; Telegram asks for it on every press. Never throws. */
  async ack(id: string, text?: string): Promise<void> {
    const api = this.client();
    if (!api) return;
    await api.answerCallbackQuery(id, text).catch((e) => this.noteFailure(e));
  }

  /** The Settings button: a test message, with an error fit for the page. */
  async test() {
    await this.send(t('tg.msg.test')).catch((e) => { throw userError(e); });
  }

  private noteFailure(e: unknown) {
    if (e instanceof TelegramError && e.kind === 'auth') this.setTrouble('invalid');
    log.warn('telegram', e instanceof TelegramError ? e.message : 'failed');
  }

  private async stopPolling() {
    const p = this.poller;
    this.poller = null;
    if (!p) return this.stopping ?? undefined;
    if (p.nextOffset !== null) this.offset = p.nextOffset;
    const run = p.stop().then(() => { if (p.nextOffset !== null) this.offset = p.nextOffset; });
    this.stopping = run;
    try { await run; } finally { if (this.stopping === run) this.stopping = null; }
  }

  /** Stops everything that runs: polling and the code's timer. */
  async halt() {
    if (this.expiry) { clearTimeout(this.expiry); this.expiry = null; }
    this.pairing = null;
    this.candidate = null;
    await this.stopPolling();
  }
}

export const telegram = new TelegramLink();
