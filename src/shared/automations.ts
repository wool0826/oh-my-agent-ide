// Automations: work the Dispatcher is handed without the user typing it, on a schedule (every day, on weekdays, once a
// week, every N hours) or on a GitHub event (a PR merged or opened, CI failing, a review asked of the user, an issue
// labelled), at most a set number of times a day (T-0180, spec 9A).

import type { Automation, AutoTrigger, AutoEventKind } from './types';

/** "9", "9:5", "09:30" as "HH:MM"; null when it is not a time of day. */
export function parseTime(text: string): string | null {
  const m = /^\s*(\d{1,2})(?:\s*[:.]\s*(\d{1,2}))?\s*$/.exec(text);
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2] ?? 0);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** The trigger menu, in its order: the schedules, then the events. "weekdays" is a daily trigger on weekdays. */
export const SCHEDULE_CHOICES = ['daily', 'weekdays', 'weekly', 'every'] as const;
export const EVENT_CHOICES = ['merged', 'ciFailed', 'prOpened', 'reviewRequested', 'issueLabel'] as const;
export type TriggerChoice = typeof SCHEDULE_CHOICES[number] | AutoEventKind;

export function isEventKind(kind: string): kind is AutoEventKind {
  return (EVENT_CHOICES as readonly string[]).includes(kind);
}

/** The menu entry a trigger shows as. */
export function choiceOf(t: AutoTrigger): TriggerChoice {
  return t.kind === 'daily' && t.weekdays ? 'weekdays' : t.kind;
}

/** Events that take a branch (the base of a PR, the branch CI ran on); an issue takes a label instead. */
export const takesBranch = (kind: string) => kind === 'merged' || kind === 'ciFailed' || kind === 'prOpened';

/** The limits a day the form offers, and the default for a new automation. */
export const PER_DAY_MAX = 24;
export const PER_DAY_DEFAULT = 3;

/** A limit a day from a form or a tool: 1–24, else none (null). */
export function clampPerDay(v: unknown): number | null {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 1 ? Math.min(PER_DAY_MAX, n) : null;
}

export type TriggerError = 'badTime' | 'badHours' | 'badLabel' | 'badDay';

/**
 * A trigger from the window or the Dispatcher, cleaned up: a time as "HH:MM", hours 1–24, a weekday 0 (Sunday)–6, a
 * label that is not empty, a repository and a branch trimmed (empty: any). An error says which field is wrong.
 */
export function normalizeTrigger(input: AutoTrigger): AutoTrigger | { error: TriggerError } {
  const k = input.kind;
  if (k === 'daily' || k === 'weekly') {
    const time = parseTime(input.time ?? '');
    if (!time) return { error: 'badTime' };
    if (k === 'daily') return { kind: 'daily', time, weekdays: !!input.weekdays };
    const day = Number(input.day);
    if (!Number.isInteger(day) || day < 0 || day > 6) return { error: 'badDay' };
    return { kind: 'weekly', time, day };
  }
  if (k === 'every') {
    const hours = Number(input.hours);
    if (!Number.isInteger(hours) || hours < 1 || hours > 24) return { error: 'badHours' };
    return { kind: 'every', hours };
  }
  const repo = input.repo?.trim() || undefined;
  if (k === 'issueLabel') {
    const label = input.label?.trim();
    if (!label) return { error: 'badLabel' };
    return { kind: k, repo, label };
  }
  if (k === 'reviewRequested') return { kind: k, repo };
  if (k === 'merged' && !repo && !input.branch?.trim()) return { kind: 'merged' };
  return { kind: k, repo, branch: input.branch?.trim() || undefined };
}

/** Two triggers that run at the same times and on the same events. */
export function sameTrigger(a: AutoTrigger, b: AutoTrigger): boolean {
  return JSON.stringify(normalizeTrigger(a)) === JSON.stringify(normalizeTrigger(b));
}

/**
 * When a scheduled automation runs next after `after`, in local time. Daily: today at its time if that is still
 * ahead, else the next day, skipping Saturday and Sunday on weekdays only. Weekly: the next of its weekday at its
 * time. Every N hours: N hours after `after`. Null for an event trigger.
 */
export function nextRun(trigger: AutoTrigger, after: Date): Date | null {
  if (trigger.kind === 'every') return new Date(after.getTime() + Math.max(1, trigger.hours) * 3_600_000);
  if (trigger.kind !== 'daily' && trigger.kind !== 'weekly') return null;
  const [h, m] = (parseTime(trigger.time) ?? '09:00').split(':').map(Number);
  const at = new Date(after.getFullYear(), after.getMonth(), after.getDate(), h, m, 0, 0);
  if (at.getTime() <= after.getTime()) at.setDate(at.getDate() + 1);
  if (trigger.kind === 'weekly') while (at.getDay() !== trigger.day) at.setDate(at.getDate() + 1);
  else while (trigger.weekdays && (at.getDay() === 0 || at.getDay() === 6)) at.setDate(at.getDate() + 1);
  return at;
}

/** Is a scheduled automation due: switched on, and its time has come. */
export function isDue(a: Pick<Automation, 'enabled' | 'trigger' | 'nextRunAt'>, now: Date): boolean {
  return a.enabled && !isEventKind(a.trigger.kind) && !!a.nextRunAt && Date.parse(a.nextRunAt) <= now.getTime();
}

/** The local day of `d` as "YYYY-MM-DD", the period of the limit a day. */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** How many times it ran today. */
export function runsToday(a: Pick<Automation, 'runs'>, now: Date): number {
  return a.runs?.day === dayKey(now) ? a.runs.n : 0;
}

/** It ran as many times today as its limit allows: what sets it off now is skipped until tomorrow. */
export function atLimit(a: Pick<Automation, 'runs' | 'maxPerDay'>, now: Date): boolean {
  return !!a.maxPerDay && runsToday(a, now) >= a.maxPerDay;
}

/** The count after one more run at `now`. */
export function countRun(a: Pick<Automation, 'runs'>, now: Date): { day: string; n: number } {
  return { day: dayKey(now), n: runsToday(a, now) + 1 };
}

/** A name for the list when none is given: the first line of what it asks for. */
export function autoTitle(prompt: string, max = 48): string {
  const line = prompt.trim().split('\n')[0].replace(/\s+/g, ' ');
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/**
 * An automation after the user changed its text, when it runs or its limit. It stays on or off, and keeps when it
 * last ran. A name that was the text's first line follows the new text; one given by hand (by the Dispatcher) stays.
 * The next run is worked out again only when the trigger changed, so saving the same time does not skip a run.
 * `trigger` is a normalized one.
 */
export function editedAutomation(a: Automation, prompt: string, trigger: AutoTrigger, now: Date, maxPerDay: number | null = a.maxPerDay ?? null): Automation {
  const text = prompt.trim();
  const same = sameTrigger(a.trigger, trigger);
  return {
    ...a,
    title: a.title === autoTitle(a.prompt) ? autoTitle(text) : a.title,
    prompt: text,
    trigger,
    maxPerDay,
    nextRunAt: same ? a.nextRunAt : nextRun(trigger, now)?.toISOString() ?? null,
  };
}

/** What the Dispatcher is told when an automation fires. `context` says what set it off (the merged PR). */
export function automationMessage(a: Pick<Automation, 'title' | 'prompt'>, context = ''): string {
  return `[Automation: ${a.title.replace(/[\]\n]/g, ' ')}]\n${context ? `${context}\n` : ''}${a.prompt.trim()}`;
}

/** Something that happened on GitHub that an event automation can wait for. `id` is unique within its kind and repo. */
export interface AutoEvent {
  kind: AutoEventKind;
  repo: string;
  id: string;
  /** The PR's base, or the branch CI ran on. */
  branch?: string;
  /** The issue's labels. */
  labels?: string[];
  title?: string;
  url?: string;
}

/** Does the event set off this trigger: same kind, and the repository, branch and label it names (none: any). */
export function matchesEvent(t: AutoTrigger, ev: AutoEvent): boolean {
  if (t.kind !== ev.kind || !isEventKind(t.kind)) return false;
  const e = t as Extract<AutoTrigger, { kind: AutoEventKind }>;
  if (e.repo && e.repo !== ev.repo) return false;
  if (e.branch && takesBranch(t.kind) && e.branch !== ev.branch) return false;
  if (t.kind === 'issueLabel' && !(ev.labels ?? []).some((l) => l.toLowerCase() === (e.label ?? '').toLowerCase())) return false;
  return true;
}

/** What the Dispatcher is told set the automation off. */
export function eventContext(ev: AutoEvent): string {
  const what = ev.url ?? `#${ev.id}`;
  const title = ev.title ? ` ("${ev.title}")` : '';
  const where = `repository ${ev.repo}${ev.branch ? `, branch ${ev.branch}` : ''}`;
  switch (ev.kind) {
    case 'merged': return `PR ${what}${title} was merged (${where}).`;
    case 'ciFailed': return `CI failed: ${what}${title} (${where}). Read its log with \`gh run view --log-failed\`.`;
    case 'prOpened': return `PR ${what}${title} was opened (${where}).`;
    case 'reviewRequested': return `Your review was requested on PR ${what}${title} (${where}).`;
    case 'issueLabel': return `Issue ${what}${title} has the label ${(ev.labels ?? []).join(', ')} (${where}).`;
  }
}

/** One watch on GitHub: an event kind in a repository (and a label for issues). */
export interface EventWatch { kind: Exclude<AutoEventKind, 'merged'>; repo: string; label?: string }

/** The key a watch keeps what it has seen under. */
export const watchKey = (w: EventWatch) => `${w.kind}|${w.repo}${w.label ? `|${w.label.toLowerCase()}` : ''}`;

/**
 * What to read from GitHub for the automations switched on: each event kind once per repository (and label). One that
 * names no repository watches every repository on GitHub. Merges come from the PR watch, not from here.
 */
export function eventWatches(list: readonly Pick<Automation, 'enabled' | 'trigger'>[], repos: readonly string[]): EventWatch[] {
  const out = new Map<string, EventWatch>();
  for (const a of list) {
    const t = a.trigger;
    if (!a.enabled || !isEventKind(t.kind) || t.kind === 'merged') continue;
    const e = t as Extract<AutoTrigger, { kind: AutoEventKind }>;
    for (const repo of e.repo ? [e.repo] : repos) {
      if (!repos.includes(repo)) continue;
      const w: EventWatch = { kind: t.kind, repo, ...(t.kind === 'issueLabel' ? { label: e.label } : {}) };
      out.set(watchKey(w), w);
    }
  }
  return [...out.values()];
}

/** How many ids a watch remembers. */
export const SEEN_MAX = 200;

/**
 * The events not seen before, and what is seen after them. The first look (`seen` undefined) only takes note, so
 * what was already there when an automation was set up does not set it off.
 */
export function freshEvents(seen: readonly string[] | undefined, events: readonly AutoEvent[]): { fresh: AutoEvent[]; seen: string[] } {
  const ids = events.map((e) => e.id);
  if (!seen) return { fresh: [], seen: ids.slice(0, SEEN_MAX) };
  const had = new Set(seen);
  const fresh = events.filter((e) => !had.has(e.id));
  return { fresh, seen: [...fresh.map((e) => e.id), ...seen].slice(0, SEEN_MAX) };
}

type Json = Record<string, unknown>;
const arr = (text: string): Json[] => { try { const v = JSON.parse(text); return Array.isArray(v) ? v : []; } catch { return []; } };
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

/**
 * GitHub's answer for a watch as events. `gh run list --json databaseId,conclusion,headBranch,displayTitle,url`
 * keeps the failed runs; `gh pr list --json number,title,url,baseRefName` the PRs (`own`: URLs of PRs the app's own
 * Workers opened, left out of "PR opened"); `gh issue list --json number,title,url,labels` the issues.
 */
export function parseEvents(w: EventWatch, text: string, own: ReadonlySet<string> = new Set()): AutoEvent[] {
  const rows = arr(text);
  if (w.kind === 'ciFailed') {
    return rows.filter((r) => r.conclusion === 'failure' && r.databaseId != null)
      .map((r) => ({ kind: w.kind, repo: w.repo, id: String(r.databaseId), branch: str(r.headBranch), title: str(r.displayTitle), url: str(r.url) }));
  }
  if (w.kind === 'issueLabel') {
    return rows.filter((r) => r.number != null).map((r) => ({
      kind: w.kind, repo: w.repo, id: String(r.number), title: str(r.title), url: str(r.url),
      labels: (Array.isArray(r.labels) ? r.labels : []).map((l: Json) => str(l?.name) ?? '').filter(Boolean),
    }));
  }
  return rows.filter((r) => r.number != null && !(w.kind === 'prOpened' && own.has(str(r.url) ?? '')))
    .map((r) => ({ kind: w.kind, repo: w.repo, id: String(r.number), branch: str(r.baseRefName), title: str(r.title), url: str(r.url) }));
}

/** The `gh` arguments that read a watch (run in the repository; `-R` is added by the caller). */
export function watchArgs(w: EventWatch): string[] {
  switch (w.kind) {
    case 'ciFailed': return ['run', 'list', '--limit', '20', '--json', 'databaseId,conclusion,headBranch,displayTitle,url'];
    case 'prOpened': return ['pr', 'list', '--state', 'open', '--limit', '30', '--json', 'number,title,url,baseRefName'];
    case 'reviewRequested': return ['pr', 'list', '--state', 'open', '--search', 'review-requested:@me', '--limit', '30', '--json', 'number,title,url,baseRefName'];
    case 'issueLabel': return ['issue', 'list', '--state', 'open', '--label', w.label ?? '', '--limit', '30', '--json', 'number,title,url,labels'];
  }
}
