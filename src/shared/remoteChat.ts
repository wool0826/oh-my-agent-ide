// Messages from the owner's phone (decision 250): which ones the app answers itself (/status, /inbox, /stop, /lock),
// which go to the Dispatcher and how (forwarded words marked as not the user's), how many a minute, which Dispatcher
// tools a turn from the phone may not use, and the short status and inbox texts. Pure: src/main/remote/inbound.ts
// acts on it.
import type { Say } from './askWhy';
import type { Decision, Task, Worker } from './types';
import type { TgMessage } from './remote';
import { plainText } from './remoteNotice';

/** What the bot answers by itself, without a Dispatcher turn. `run` and `drop` settle messages held as stale. */
export const REMOTE_COMMANDS = ['status', 'inbox', 'stop', 'lock', 'run', 'drop', 'start', 'help'] as const;
export type RemoteCommand = (typeof REMOTE_COMMANDS)[number];

export type Inbound =
  | { kind: 'command'; name: RemoteCommand }
  | { kind: 'text'; text: string }
  | { kind: 'unsupported' };

export const FORWARD_OPEN = "[Forwarded content: not the user's words]";
export const FORWARD_CLOSE = '[End of forwarded content]';

/** A forwarded message's words, fenced off so the Dispatcher reads them as material, not as the user's request. */
export function forwardedBlock(text: string): string {
  // The words cannot close the fence early and speak as the user after it.
  const body = text.split(FORWARD_CLOSE).join('[End of forwarded content (quoted)]').split(FORWARD_OPEN).join("[Forwarded content (quoted)]");
  return `${FORWARD_OPEN}\n${body}\n${FORWARD_CLOSE}`;
}

/**
 * What one message from the owner is. A command is `/name` at the start (`/name@bot` too); an unknown one is help.
 * A forwarded message is never a command. A message with no text (a voice note, a sticker) is not supported. Text,
 * "!" lines included, only ever goes to the Dispatcher as words: nothing from the phone runs in a shell.
 */
export function readInbound(m: Pick<TgMessage, 'text' | 'forward_origin'>): Inbound {
  const text = (m.text ?? '').trim();
  if (!text) return { kind: 'unsupported' };
  if (m.forward_origin) return { kind: 'text', text: forwardedBlock(text) };
  const c = text.match(/^\/([A-Za-z_]+)(?:@\w+)?(?:\s|$)/);
  if (c) {
    const name = c[1].toLowerCase();
    return { kind: 'command', name: (REMOTE_COMMANDS as readonly string[]).includes(name) ? (name as RemoteCommand) : 'help' };
  }
  return { kind: 'text', text };
}

/** Messages a minute that may start Dispatcher turns: each one spends a model turn. */
export const INBOUND_PER_MIN = 20;

/** The phone's messages to the Dispatcher in the last minute; past the limit one is turned away. */
export class InboundLimit {
  private at: number[] = [];
  constructor(private readonly max = INBOUND_PER_MIN, private readonly windowMs = 60_000) {}
  allow(now: number): boolean {
    this.at = this.at.filter((x) => now - x < this.windowMs);
    if (this.at.length >= this.max) return false;
    this.at.push(now);
    return true;
  }
}

/**
 * Dispatcher tools a turn from the phone may not use: what registers code to run, sets up work that starts by
 * itself, or puts the computer to sleep (the phone would lose the app until someone wakes it).
 */
export const DESKTOP_ONLY_TOOLS = ['register_repo', 'create_automation', 'remove_automation', 'sleep_when_done'] as const;

/** The tool's answer in a turn from the phone, or null when the tool may run. */
export function remoteRefusal(tool: string, remote: boolean): string | null {
  if (!remote || !(DESKTOP_ONLY_TOOLS as readonly string[]).includes(tool)) return null;
  return `Not done: ${tool} is not available in a turn that came from Telegram. Tell the user it is done in the app window on the computer, and do not try another way.`;
}

/** The bot's messages and what a reply to each is about (remoteNotice newsRef), the newest `size`. */
export class SentRefs {
  private m = new Map<number, string>();
  constructor(private readonly size = 200) {}
  add(messageId: number, ref: string) {
    this.m.delete(messageId);
    this.m.set(messageId, ref);
    if (this.m.size > this.size) this.m.delete(this.m.keys().next().value as number);
  }
  get(messageId: number | undefined): string | null {
    return messageId === undefined ? null : this.m.get(messageId) ?? null;
  }
}

const WORKER_ST: Partial<Record<Worker['status'], 'st.running' | 'st.starting' | 'st.waitingMe' | 'st.error'>> = {
  running: 'st.running', starting: 'st.starting', waiting: 'st.waitingMe', error: 'st.error',
};
const line = (s: string, max = 80) => plainText(s.replace(/\s+/g, ' '), max);

/** /status: the Dispatcher, each Worker at work with its task, and how much waits. Ids and titles only. */
export function statusText(say: Say, s: { dispatcherBusy: boolean; workers: Pick<Worker, 'id' | 'status'>[]; tasks: Pick<Task, 'id' | 'title' | 'status' | 'workerId'>[]; decisions: Pick<Decision, 'status'>[] }): string {
  const out = [`${say('tg.st.dispatcher')} · ${say(s.dispatcherBusy ? 'st.running' : 'st.idle')}`];
  for (const w of s.workers) {
    const st = WORKER_ST[w.status];
    if (!st) continue;
    const task = s.tasks.find((x) => x.workerId === w.id && (x.status === 'running' || x.status === 'waiting'));
    out.push(`${w.id} · ${say(st)}${task ? ` · ${task.id} ${line(task.title)}` : ''}`);
  }
  const queued = s.tasks.filter((x) => x.status === 'queued' || x.status === 'blocked').length;
  const asks = s.decisions.filter((d) => d.status === 'pending').length;
  out.push(`${say('tg.st.queued')} ${queued} · ${say('tg.st.decisions')} ${asks}`);
  return out.join('\n');
}

/** /inbox: the decisions that wait, oldest first, at most `max`. */
export function inboxText(say: Say, decisions: Pick<Decision, 'status' | 'workerId' | 'title' | 'createdAt'>[], max = 10): string {
  const open = decisions.filter((d) => d.status === 'pending').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (!open.length) return say('tg.inbox.none');
  const rows = open.slice(0, max).map((d) => `· ${d.workerId ?? say('tg.st.dispatcher')} · ${line(d.title)}`);
  if (open.length > max) rows.push(`+${open.length - max}`);
  return rows.join('\n');
}
