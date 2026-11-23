// A side question (T-0053 item 3): a plain Claude Code session beside the Dispatcher, with its own context. It reads
// and answers; it creates nothing, and nothing in it reaches the Dispatcher unless the user sends it over.
import type { ModelInfo } from './types';
import type { Reply } from './reply';

export interface SideItem { role: 'me' | 'ai' | 'error'; text: string }

/** What the window shows of the side question. Kept in memory only: closing it, or quitting the app, forgets it. */
export interface SideView {
  items: SideItem[];
  busy: boolean;
  /** What it is doing now (a tool it runs), while busy. */
  status: string;
  /** Set by the first question; the model and folder change only after Close. */
  model: string | null;
  repo: string | null;
  contextTokens: number;
}

export const SIDE_EMPTY: SideView = { items: [], busy: false, status: '', model: null, repo: null, contextTokens: 0 };

/** Who a side answer sent to the Dispatcher is quoted from (the reply header the Dispatcher reads). */
export const SIDE_WHO = 'side question';
/** How much of a side answer goes to the Dispatcher: more than a reply's quote, as the answer is the point. */
export const SIDE_QUOTE_MAX = 2000;
/** Items kept in the thread; the session keeps its own context regardless. */
export const SIDE_KEEP = 100;

/** The quote chip "From a side question" on the Dispatcher's composer, for one answer. */
export function sideReply(answer: string): Reply {
  return { who: SIDE_WHO, quote: answer, max: SIDE_QUOTE_MAX, icon: 's-side-q' };
}

/** The model a side question starts with: the newest Sonnet the accounts have, else the newest Claude model. */
export function sideModel(models: readonly ModelInfo[], fallback = 'claude-sonnet-5-5'): string {
  const claude = models.filter((m) => (m.provider ?? (/^claude/i.test(m.id) ? 'claude' : 'chatgpt')) === 'claude');
  const newest = (list: readonly ModelInfo[]) => [...list].sort((a, b) => b.created.localeCompare(a.created))[0]?.id;
  return newest(claude.filter((m) => /sonnet/i.test(m.id))) ?? newest(claude) ?? fallback;
}

/** The thread with an item added, its oldest items dropped past SIDE_KEEP. */
export function addSideItem(items: SideItem[], item: SideItem, keep = SIDE_KEEP): SideItem[] {
  const next = [...items, item];
  return next.length > keep ? next.slice(-keep) : next;
}

/** The answer to the last question (all it said since), the one "Send to the Dispatcher" and "Save as memo" take. */
export function lastAnswer(items: readonly SideItem[]): string | null {
  const said: string[] = [];
  for (let i = items.length - 1; i >= 0 && items[i].role !== 'me'; i--) if (items[i].role === 'ai') said.unshift(items[i].text);
  return said.length ? said.join('\n\n') : null;
}
