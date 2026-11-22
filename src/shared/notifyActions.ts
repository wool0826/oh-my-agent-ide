// Buttons on a decision's OS notification, so a simple one is answered without opening the window (decision 118).

import { ALLOW, DENY, type Decision } from './types';

export interface NotifyAction {
  /** allow / deny are named by the app; an option keeps its own words. */
  label: { key: 'allow' | 'deny' } | { text: string };
  /** What answering with this button sends, the same value the inbox card's button sends. */
  answer: string;
}

/** The OS shows a few short buttons at most. */
const MAX_BUTTONS = 3;
const MAX_LABEL = 28;

/**
 * A permission gets Allow and Deny. A question gets its options when they are few, short and need no
 * description to choose between. A plan gets none: it has to be read first.
 */
export function notifyActions(d: Pick<Decision, 'source' | 'options'>): NotifyAction[] {
  if (d.source === 'permission') return [{ label: { key: 'allow' }, answer: ALLOW }, { label: { key: 'deny' }, answer: DENY }];
  if (d.source === 'plan') return [];
  const o = d.options;
  if (o.length < 2 || o.length > MAX_BUTTONS) return [];
  if (o.some((x) => x.description || x.label.length > MAX_LABEL)) return [];
  return o.map((x) => ({ label: { text: x.label }, answer: x.label }));
}
