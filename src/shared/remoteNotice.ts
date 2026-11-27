// What the phone gets (decision 246): one-way notices for decisions, task results, PRs that merged or closed, and
// errors; how much of each is sent; and the queue that holds them until they go. Pure: the bridge in
// src/main/remote/bridge.ts sends what this decides.
import type { Say } from './askWhy';
import type { Decision } from './types';
import { doneNotice } from './notifyRules';
import type { Choice, TgButton } from './remoteDecision';

export const REMOTE_EVENTS = ['decisions', 'results', 'prs', 'errors', 'replies'] as const;
export type RemoteEvent = (typeof REMOTE_EVENTS)[number];
/** `title`: who and what only. `summary`: also the result's summary, the question and links, never code or files. */
export type RemoteLevel = 'title' | 'summary';
/**
 * `requests`: messages from the phone go to the Dispatcher (decision 250). `buttons`: decisions carry buttons and a
 * reply answers them (decision 251). Off is notices only, as /lock leaves both.
 */
export interface RemotePrefs { events: Record<RemoteEvent, boolean>; level: RemoteLevel; requests: boolean; buttons: boolean }

export const REMOTE_PREFS_DEFAULT: RemotePrefs = { events: { decisions: true, results: true, prs: true, errors: true, replies: true }, level: 'summary', requests: true, buttons: true };

export function cleanPrefs(raw: unknown): RemotePrefs {
  const r = (raw && typeof raw === 'object' ? raw : {}) as { events?: unknown; level?: unknown; requests?: unknown; buttons?: unknown };
  const ev = (r.events && typeof r.events === 'object' ? r.events : {}) as Record<string, unknown>;
  const events = Object.fromEntries(REMOTE_EVENTS.map((k) => [k, typeof ev[k] === 'boolean' ? ev[k] : REMOTE_PREFS_DEFAULT.events[k]])) as Record<RemoteEvent, boolean>;
  return { events, level: r.level === 'title' ? 'title' : 'summary', requests: typeof r.requests === 'boolean' ? r.requests : REMOTE_PREFS_DEFAULT.requests,
    buttons: typeof r.buttons === 'boolean' ? r.buttons : REMOTE_PREFS_DEFAULT.buttons };
}

/** Something worth a message to the phone, in plain fields so the rules need no store. */
export type RemoteNews =
  /** `choices`: what its buttons answer (remoteDecision.ts); `plan`: a plan's text, sent only with its buttons. */
  | { type: 'decision'; id: string; source: Decision['source']; who: string | null; title: string; detail: string; options: string[]; choices?: Choice[]; plan?: string }
  | { type: 'result'; task: string; who: string; title: string; summary: string; ok: boolean; label?: string; code?: boolean; prUrl?: string | null; links?: string[] }
  | { type: 'pr'; task: string; title: string; merged: boolean; prUrl: string | null }
  | { type: 'error'; text: string }
  /** What the Dispatcher said in a turn the phone started (chat item `id`). */
  | { type: 'reply'; id: string; text: string };

export function newsEvent(n: RemoteNews): RemoteEvent {
  return n.type === 'decision' ? 'decisions' : n.type === 'result' ? 'results' : n.type === 'pr' ? 'prs' : n.type === 'reply' ? 'replies' : 'errors';
}

/** A short stable hash, so a key names a text without holding it. */
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** The same news told twice (a PR settled by two checks, an error said again) has the same key. */
export function newsKey(n: RemoteNews): string {
  switch (n.type) {
    case 'decision': return `decision:${n.id}`;
    case 'result': return `result:${n.task}:${n.ok ? n.label ?? 'done' : 'failed'}:${hash(n.summary)}`;
    case 'pr': return `pr:${n.task}:${n.merged ? 'merged' : 'closed'}`;
    case 'error': return `error:${hash(n.text)}`;
    case 'reply': return `reply:${n.id}`;
  }
}

/** News from one source close together is one burst (notifyRules Burst): the first rings, the rest come silent. */
export function newsGroup(n: RemoteNews): string {
  switch (n.type) {
    case 'decision': return `decision:${n.who ?? 'dispatcher'}`;
    case 'result': return n.ok ? `info:${n.who}` : `info:${n.who}:failed`;
    case 'pr': return 'pr';
    case 'error': return 'error';
    case 'reply': return 'reply';
  }
}

/**
 * Text that may leave the computer: code blocks and indented code are dropped, blank runs closed up, and the rest
 * cut at `max` characters.
 */
export function plainText(text: string, max = 600): string {
  const out = text
    .replace(/```[\s\S]*?(```|$)/g, '…')
    .split(/\r?\n/)
    .filter((l) => !/^( {4}|\t)/.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return out.length > max ? `${out.slice(0, max - 1).trimEnd()}…` : out;
}

const line = (s: string, max = 200) => plainText(s.replace(/\s+/g, ' '), max);

/** The message for one piece of news at the chosen level. */
export function newsText(say: Say, n: RemoteNews, level: RemoteLevel): string {
  const full = level === 'summary';
  switch (n.type) {
    case 'decision': {
      const head = n.who ? say('noti.workerWaits', { id: n.who }) : say('noti.decision');
      // A permission asks to run something: the command and its files stay on the desktop.
      if (n.source === 'permission') return head;
      const parts = [head, line(n.title)];
      if (full && n.source !== 'plan') {
        const body = plainText(n.detail, 500);
        if (body && body !== line(n.title)) parts.push(body);
        if (n.options.length) parts.push(n.options.map((o) => `· ${line(o, 80)}`).join('\n'));
      }
      // A plan is approved from the phone only after it is read there: its text comes with its buttons.
      if (full && n.source === 'plan' && n.plan) parts.push(line(n.detail), plainText(n.plan, PLAN_MAX));
      return parts.join('\n\n');
    }
    case 'result': {
      const d = doneNotice(say, { who: n.who, title: n.title, summary: n.summary, ok: n.ok, label: n.label, code: n.code, prUrl: n.prUrl });
      const parts = [d.title, line(n.title)];
      if (full) {
        // A failed task's summary is its error text, which can quote a command or a file: only the title goes.
        const body = n.ok ? plainText(n.summary, 800) : '';
        if (body) parts.push(body);
        const links = [n.prUrl, ...(n.links ?? [])].filter((x): x is string => !!x);
        if (links.length) parts.push(links.join('\n'));
      }
      return parts.join('\n\n');
    }
    case 'pr': {
      const parts = [say(n.merged ? 'noti.merged' : 'noti.closed'), line(n.title)];
      if (full && n.prUrl) parts.push(n.prUrl);
      return parts.join('\n\n');
    }
    case 'error':
      // One line at either level: what follows it (stderr, output, paths) stays on the desktop.
      return [say('tg.n.error'), line(plainText(n.text, 600).split(/\r?\n/)[0] ?? '', 120)].filter(Boolean).join('\n\n');
    case 'reply':
      // The answer the phone asked for, at either level; code blocks stay on the desktop as everywhere else.
      return plainText(n.text, REPLY_MAX);
  }
}

/** The longest Dispatcher answer sent: three Telegram messages (remote.ts splitText). */
export const REPLY_MAX = 3 * 4000;
/** A plan's text, leaving room for its heading in the same three messages. */
const PLAN_MAX = REPLY_MAX - 600;

/**
 * One message waiting to go. `urgent` ones (decisions) are the last to be dropped when the queue is full. `ref`: what
 * a reply to it on the phone is about (newsRef); `replyTo`: the phone's message it answers; `buttons` go under its
 * last part. `edit`: not a new message but a change to the bot's message with that id (its text, or with an empty
 * text only its buttons taken off).
 */
export interface Outgoing {
  key: string; group: string; text: string; silent: boolean; urgent: boolean;
  ref?: string; replyTo?: number; buttons?: TgButton[][]; edit?: number;
}

/**
 * What a reply on the phone to this news answers: the task for a result or a PR (its report's thread), the chat
 * item for a Dispatcher answer, and `d:<id>` for a decision. Errors have none.
 */
export function newsRef(n: RemoteNews): string | undefined {
  switch (n.type) {
    case 'decision': return `d:${n.id}`;
    case 'result': case 'pr': return n.task;
    case 'reply': return n.id;
    case 'error': return undefined;
  }
}

export const QUEUE_MAX = 50;
export const DEDUPE_MS = 10 * 60_000;
/** News joins a waiting message only while the message stays within one Telegram message. */
export const MERGE_MAX = 4000;

/**
 * The messages waiting to go, oldest first. A repeat of something told within `dedupeMs` is dropped; news of a group
 * that still has a message waiting joins it (one message per burst); past `max` the oldest that is not urgent goes.
 */
export class SendQueue {
  readonly items: Outgoing[] = [];
  private recent = new Map<string, number>();
  /** The keys of the news in each waiting message, forgotten when it is dropped so the same news can come again. */
  private held = new WeakMap<Outgoing, string[]>();
  constructor(private max = QUEUE_MAX, private dedupeMs = DEDUPE_MS, private mergeMax = MERGE_MAX) {}

  /** false when it was a repeat and dropped. */
  add(o: Outgoing, now: number): boolean {
    for (const [k, at] of this.recent) if (now - at >= this.dedupeMs) this.recent.delete(k);
    if (this.recent.has(o.key)) return false;
    this.recent.set(o.key, now);
    // A message with buttons or an edit stays on its own: joined, its buttons would answer the wrong news.
    const alone = (x: Outgoing) => !!x.buttons?.length || x.edit !== undefined;
    const same = alone(o) ? undefined : [...this.items].reverse().find((x) => x.group === o.group && !alone(x));
    if (same && same.text.length + 2 + o.text.length <= this.mergeMax) {
      same.text = `${same.text}\n\n${o.text}`;
      same.silent &&= o.silent;
      same.urgent ||= o.urgent;
      // A reply on the phone to the joined message answers the first news in it.
      same.ref ??= o.ref;
      this.held.get(same)?.push(o.key);
      return true;
    }
    const item = { ...o };
    this.held.set(item, [o.key]);
    this.items.push(item);
    while (this.items.length > this.max) {
      const i = this.items.findIndex((x) => !x.urgent);
      this.forget(this.items.splice(i >= 0 ? i : 0, 1)[0]);
    }
    return true;
  }

  /** Drops a waiting message with buttons about `ref` (a decision settled before it went); true when there was one. */
  drop(ref: string): boolean {
    const i = this.items.findIndex((x) => x.ref === ref && !!x.buttons?.length);
    if (i < 0) return false;
    this.forget(this.items.splice(i, 1)[0]);
    return true;
  }

  /** A message that will not go: its news counts as untold again. */
  forget(o: Outgoing) { for (const k of this.held.get(o) ?? [o.key]) this.recent.delete(k); }

  next(): Outgoing | undefined { return this.items.shift(); }
  /** A message that could not go yet goes back to the front. */
  retry(o: Outgoing) { this.items.unshift(o); }
  clear() { for (const o of this.items) this.forget(o); this.items.length = 0; }
  get size() { return this.items.length; }
}

/** A decision as news: the option labels only, never their descriptions. */
export function decisionNews(d: Pick<Decision, 'id' | 'source' | 'workerId' | 'title' | 'detail' | 'options' | 'code'>, choices: Choice[] = []): RemoteNews {
  return {
    type: 'decision', id: d.id, source: d.source, who: d.workerId, title: d.title, detail: d.detail, options: d.options.map((o) => o.label),
    choices, plan: d.source === 'plan' ? d.code ?? undefined : undefined,
  };
}
