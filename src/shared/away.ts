// "While you were away": what ended and what came to wait for the user since they last looked (decision 122).

import type { Decision, Task } from './types';

/** Shorter absences get no card: the user has not lost track in five minutes. */
export const AWAY_MIN_MS = 5 * 60_000;

export interface AwayDigest {
  /** When the user last looked, and for how many minutes they were away. */
  since: string;
  minutes: number;
  /** Tasks that finished, newest first: done or with a PR open. */
  finished: Task[];
  /** Tasks that failed (not ones the user stopped). */
  failed: Task[];
  /** Tasks whose PR was merged. */
  merged: Task[];
  /** Decisions that came in and still wait. */
  waiting: number;
}

const after = (iso: string | null | undefined, since: number) => !!iso && Date.parse(iso) > since;
const newest = (a: Task, b: Task) => (b.finishedAt ?? b.updatedAt).localeCompare(a.finishedAt ?? a.updatedAt);

/** The digest for an absence, or null when it was short or nothing happened in it. */
export function awayDigest(s: { tasks: readonly Task[]; decisions: readonly Pick<Decision, 'status' | 'createdAt'>[] }, sinceIso: string | null, now: number): AwayDigest | null {
  const since = sinceIso ? Date.parse(sinceIso) : NaN;
  if (!Number.isFinite(since) || now - since < AWAY_MIN_MS) return null;
  const ended = s.tasks.filter((x) => after(x.finishedAt, since));
  const finished = ended.filter((x) => x.status === 'done' || x.status === 'pr_open').sort(newest);
  const failed = ended.filter((x) => x.status === 'failed' && !x.stopped).sort(newest);
  const merged = s.tasks.filter((x) => after(x.mergedAt, since)).sort(newest);
  const waiting = s.decisions.filter((d) => d.status === 'pending' && after(d.createdAt, since)).length;
  if (!finished.length && !failed.length && !merged.length && !waiting) return null;
  return { since: sinceIso!, minutes: Math.round((now - since) / 60_000), finished, failed, merged, waiting };
}

/** The tasks to list on the card, failures first, each once. */
export function awayRows(d: AwayDigest, limit = 6): { task: Task; kind: 'failed' | 'merged' | 'finished' }[] {
  const seen = new Set<string>();
  const out: { task: Task; kind: 'failed' | 'merged' | 'finished' }[] = [];
  for (const [kind, list] of [['failed', d.failed], ['merged', d.merged], ['finished', d.finished]] as const) {
    for (const task of list) if (!seen.has(task.id)) { seen.add(task.id); out.push({ task, kind }); }
  }
  return out.slice(0, limit);
}
