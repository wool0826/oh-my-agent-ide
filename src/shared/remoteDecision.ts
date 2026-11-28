// Decisions answered from the phone (decision 251): which ones get buttons and what each button answers, what a
// button carries back, and the line that replaces the buttons once the decision is settled. Pure: the bridge sends
// the buttons, remote/inbound.ts reads the presses.
import type { Say } from './askWhy';
import { notifyActions } from './notifyActions';
import type { RemoteLevel } from './remoteNotice';
import { ALLOW, ALLOW_TASK, DENY, type Decision } from './types';

/** One inline button: its label and what Telegram sends back when it is pressed (1 to 64 bytes). */
export interface TgButton { text: string; data: string }

/** What a button answers: its label on the phone and the answer the inbox card's button would send. */
export interface Choice { label: string; answer: string }

type Asked = Pick<Decision, 'source' | 'options'>;

/**
 * The answers a decision offers on the phone. A permission offers none: what runs on the computer is allowed there
 * (the T-0148 report, 2.2). A plan offers Approve and Deny, sent after the plan itself. A question offers its
 * options when the OS notification would (few, short, nothing to read first); anything else is answered by a reply.
 */
export function remoteChoices(say: Say, d: Asked): Choice[] {
  if (d.source === 'permission') return [];
  if (d.source === 'plan') return [{ label: say('plan.approve'), answer: ALLOW }, { label: say('deny'), answer: DENY }];
  return notifyActions(d).map((a) => ({ label: 'key' in a.label ? say(a.label.key) : a.label.text, answer: a.answer }));
}

/**
 * May a reply on the phone to this decision's message answer it? Not a permission, not at the title level (the
 * phone never showed what was asked: free words to a plan would revise it unseen), and not one written while the
 * app was not reading the chat.
 */
export function answersByReply(d: Pick<Decision, 'source'>, o: { level: RemoteLevel; stale: boolean }): boolean {
  return d.source !== 'permission' && o.level === 'summary' && !o.stale;
}

/** The held messages' buttons (remote/inbound.ts): send them, or drop them. */
export const HELD_RUN = 'h:run';
export const HELD_DROP = 'h:drop';

/** A decision's buttons, one row: `d:<id>:<n>`, n the choice's place. A uuid keeps it well under 64 bytes. */
export function decisionButtons(id: string, choices: Choice[]): TgButton[][] {
  if (!choices.length) return [];
  return [choices.map((c, i) => ({ text: c.label, data: `d:${id}:${i}` }))];
}

export type Press = { kind: 'decision'; id: string; n: number } | { kind: 'held'; run: boolean } | null;

/** What a pressed button means; anything the app did not send is null. */
export function readPress(data: string | undefined): Press {
  if (data === HELD_RUN || data === HELD_DROP) return { kind: 'held', run: data === HELD_RUN };
  const m = /^d:([\w-]{1,48}):(\d{1,2})$/.exec(data ?? '');
  return m ? { kind: 'decision', id: m[1], n: Number(m[2]) } : null;
}

/** An answer as the user would read it: the app's words for allow, allow for the task and deny, else as it is. */
export function shownAnswer(say: Say, d: Pick<Decision, 'source'>, ans: string): string {
  if (ans === ALLOW) return say(d.source === 'plan' ? 'plan.approve' : 'allow');
  if (ans === ALLOW_TASK) return say('allowTask');
  if (ans === DENY) return say('deny');
  return ans;
}

/** The line a decision's message ends with once it is settled, in place of its buttons. */
export function settledLine(say: Say, shown: string | null): string {
  return shown === null ? say('tg.d.withdrawn') : `→ ${shown.replace(/\s+/g, ' ').trim().slice(0, 200)}`;
}
