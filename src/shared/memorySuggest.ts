import { ALLOW, DENY, type MemorySuggestion } from './types';

/**
 * Rules for "Remember this?" cards (see agents/memorySuggest.ts): when to ask the model,
 * what of its answer to show, and when memory already holds the fact.
 */

/** Past cards kept so the one-per-task limit still holds after a card is answered. */
export const KEEP_SUGGESTIONS = 200;

/** A bare allow or deny says nothing to remember; a chosen option, a typed reason or a revision might. */
export function answerWorthChecking(answer: string | null) {
  const a = (answer ?? '').trim();
  return a.length > 0 && a !== ALLOW && a !== DENY;
}

/** At most one card per key (a task, or a decision without a task), and one check at a time per key. */
export function canSuggest(list: MemorySuggestion[], key: string, busy: ReadonlySet<string> = new Set()) {
  return !busy.has(key) && !list.some((s) => s.key === key);
}

/** Where a fact came from, saved after it in memory: "T-0014 W-13 decision:1a2b3c4d". */
export function sourceTag(p: { taskId: string | null; workerId: string | null; kind: 'decision' | 'correction'; id: string }) {
  return [p.taskId, p.workerId, `${p.kind}:${p.id.slice(0, 8)}`].filter(Boolean).join(' ');
}

export interface Picked { scope: 'preference' | 'repo'; text: string; reason: string }

/** Turn the model's structured output into a card, or null unless it is sure, new and well formed. */
export function pickSuggestion(out: unknown, repo: string | null): Picked | null {
  if (!out || typeof out !== 'object') return null;
  const o = out as Record<string, unknown>;
  if (o.remember !== true || o.confidence !== 'high' || o.duplicate === true) return null;
  const text = typeof o.text === 'string' ? o.text.replace(/\s+/g, ' ').trim() : '';
  if (text.length < 4 || text.length > 300) return null;
  // A repository trait needs a repository; never file it under preferences instead.
  const scope = o.scope === 'preference' ? 'preference' : o.scope === 'repo' && repo ? 'repo' : null;
  if (!scope) return null;
  return { scope, text, reason: typeof o.reason === 'string' ? o.reason.replace(/\s+/g, ' ').trim() : '' };
}

// Common Korean particles, so "pnpm을" still matches "pnpm".
const PARTICLE = /(으로|에서|에게|하고|은|는|이|가|을|를|에|의|로|와|과|도|만)$/;

export function memTerms(s: string) {
  const words = s.toLowerCase().split(/[\s,.;:!?()[\]{}"'`/\\_*~→-]+/);
  return [...new Set(words.map((w) => {
    const x = w.replace(PARTICLE, '');
    return x.length >= 2 ? x : w;
  }).filter((x) => x.length >= 2))];
}

/** Share of the candidate's words that already appear in the line. */
export function overlap(candidate: string, line: string) {
  const ts = memTerms(candidate);
  if (!ts.length) return 0;
  const l = line.toLowerCase();
  return ts.filter((x) => l.includes(x)).length / ts.length;
}

/** Memory already holds the fact when one line has most of its words. */
export function alreadyKnown(candidate: string, lines: string[], threshold = 0.7) {
  return lines.some((l) => overlap(candidate, l) >= threshold);
}

/** Drop the oldest answered cards past the limit; waiting cards stay. */
export function trimSuggestions(list: MemorySuggestion[], keep = KEEP_SUGGESTIONS) {
  let extra = list.length - keep;
  if (extra <= 0) return list;
  return list.filter((s) => s.status === 'pending' || extra-- <= 0);
}
