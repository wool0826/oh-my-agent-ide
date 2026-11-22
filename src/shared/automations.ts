// Automations: work the Dispatcher is handed without the user typing it, every day at a time or when a PR is merged.

import type { Automation, AutoTrigger } from './types';

/** "9", "9:5", "09:30" as "HH:MM"; null when it is not a time of day. */
export function parseTime(text: string): string | null {
  const m = /^\s*(\d{1,2})(?:\s*[:.]\s*(\d{1,2}))?\s*$/.exec(text);
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2] ?? 0);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/**
 * When a daily automation runs next after `after`, in local time: today at its time if that is still ahead,
 * else the next day, skipping Saturday and Sunday when it runs on weekdays only. Null for an event trigger.
 */
export function nextRun(trigger: AutoTrigger, after: Date): Date | null {
  if (trigger.kind !== 'daily') return null;
  const [h, m] = (parseTime(trigger.time) ?? '09:00').split(':').map(Number);
  const at = new Date(after.getFullYear(), after.getMonth(), after.getDate(), h, m, 0, 0);
  if (at.getTime() <= after.getTime()) at.setDate(at.getDate() + 1);
  while (trigger.weekdays && (at.getDay() === 0 || at.getDay() === 6)) at.setDate(at.getDate() + 1);
  return at;
}

/** Is a daily automation due: switched on, and its time has come. */
export function isDue(a: Pick<Automation, 'enabled' | 'trigger' | 'nextRunAt'>, now: Date): boolean {
  return a.enabled && a.trigger.kind === 'daily' && !!a.nextRunAt && Date.parse(a.nextRunAt) <= now.getTime();
}

/** A name for the list when none is given: the first line of what it asks for. */
export function autoTitle(prompt: string, max = 48): string {
  const line = prompt.trim().split('\n')[0].replace(/\s+/g, ' ');
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** What the Dispatcher is told when an automation fires. `context` says what set it off (the merged PR). */
export function automationMessage(a: Pick<Automation, 'title' | 'prompt'>, context = ''): string {
  return `[Automation: ${a.title.replace(/[\]\n]/g, ' ')}]\n${context ? `${context}\n` : ''}${a.prompt.trim()}`;
}
