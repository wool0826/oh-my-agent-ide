// The three-line summary at the top of a plan-first plan (WHAT / HOW / OUTPUT), shown on the plan card
// so the user can approve from it. Pure functions: the main process parses, the renderer only displays.

import type { PlanSummary } from './types';

/** Label words per line, longest first. Korean labels are accepted too, though Workers are told to write the English ones. */
const LABELS: Record<keyof Omit<PlanSummary, 'auto'>, string[]> = {
  what: ['what', '무엇을', '무엇'],
  how: ['how', '어떻게'],
  output: ['output', '결과물', '산출물', '결과'],
};

/** Only this many non-empty lines from the top are searched, so a "How:" deep in the details is not taken. */
const HEAD_LINES = 20;
const MAX = 240;

/** Plan lines outside fenced code blocks, trimmed and non-empty. */
function proseLines(plan: string): string[] {
  const out: string[] = [];
  let fence = false;
  for (const raw of plan.split(/\r?\n/)) {
    const l = raw.trim();
    if (/^(```|~~~)/.test(l)) { fence = !fence; continue; }
    if (!fence && l) out.push(l);
  }
  return out;
}

/** Markdown emphasis and links reduced to their text; `code` spans stay for the renderer. */
function plain(s: string) {
  return s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/^(\*\*|__)|(\*\*|__)$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function clip(s: string, n = MAX) {
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}

/** A line without its list marker, quote marker or heading hashes. */
function unmark(l: string) {
  return l.replace(/^(#{1,6}\s+|>\s*|[-*+•]\s+|\d+[.)]\s+)+/, '');
}

/** "WHAT: …", "**WHAT:** …", "- **What**: …", "무엇을: …" → [key, value]. The value may be empty (it is on the next line). */
function labelled(l: string): [keyof typeof LABELS, string] | null {
  const s = unmark(l).replace(/^(\*\*|__)/, '');
  for (const key of Object.keys(LABELS) as (keyof typeof LABELS)[]) {
    for (const word of LABELS[key]) {
      if (s.slice(0, word.length).toLowerCase() !== word) continue;
      const m = s.slice(word.length).match(/^\s*(?:\*\*|__)?\s*[:：]\s*(?:\*\*|__)?\s*(.*)$/);
      if (m) return [key, m[1]];
    }
  }
  return null;
}

/** The WHAT / HOW / OUTPUT lines near the top of the plan, or null unless all three are there. */
export function planSummary(plan: string): PlanSummary | null {
  const lines = proseLines(plan).slice(0, HEAD_LINES);
  const found: Partial<Record<keyof typeof LABELS, string>> = {};
  lines.forEach((l, i) => {
    const hit = labelled(l);
    if (!hit || found[hit[0]] !== undefined) return;
    // The sentence may sit on the line below its label.
    let v = plain(hit[1]);
    if (!v && lines[i + 1] && !labelled(lines[i + 1])) v = plain(unmark(lines[i + 1]));
    if (v) found[hit[0]] = clip(v);
  });
  return found.what && found.how && found.output ? { what: found.what, how: found.how, output: found.output } : null;
}

const HOW_HEAD = /approach|how|step|implement|change|design|method|방법|접근|구현|변경|설계|단계/i;
const OUT_HEAD = /output|result|deliver|outcome|verif|test|결과|산출|검증|테스트/i;

/** The first sentence of a line. */
function sentence(l: string) {
  const s = plain(unmark(l));
  const m = s.match(/^(.+?[.!?。])(\s|$)/);
  return clip(m ? m[1] : s, 160);
}

/**
 * A summary pulled from the plan itself, for a Worker that left out the three lines even when asked:
 * the title heading (or first sentence) as what, the first sentence under an approach-like heading as how,
 * and the first under a result- or verification-like heading as output. Marked auto; null for an empty plan.
 */
export function planFallback(plan: string): PlanSummary | null {
  const lines = proseLines(plan);
  const sections: { head: string; body: string[] }[] = [{ head: '', body: [] }];
  for (const l of lines) {
    if (/^#{1,6}\s/.test(l)) sections.push({ head: plain(unmark(l)), body: [] });
    else sections[sections.length - 1].body.push(l);
  }
  const used = new Set<string>();
  const take = (s: string | undefined) => { if (s) used.add(s); return s ?? ''; };
  const firstUnder = (re: RegExp) => sections.find((x) => re.test(x.head) && x.body.length && !used.has(x.body[0]))?.body[0];
  const nextUnused = () => lines.find((l) => !/^#{1,6}\s/.test(l) && !used.has(l));

  const title = sections.find((x) => x.head)?.head.replace(/^(plan|계획)\s*[:：-]\s*/i, '');
  const what = title ? clip(title, 160) : sentence(take(nextUnused()));
  const howLine = take(firstUnder(HOW_HEAD) ?? nextUnused());
  const outLine = take(firstUnder(OUT_HEAD) ?? nextUnused());
  const how = howLine ? sentence(howLine) : '';
  const output = outLine ? sentence(outLine) : '';
  return what || how || output ? { what, how, output, auto: true } : null;
}
