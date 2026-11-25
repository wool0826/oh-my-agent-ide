// Which Worker takes a new task when the Dispatcher does not name one: an idle Worker that already knows the
// repository (and, better, the same area of it), with room left in its context and nothing else open.
// A new Worker is created only when none fits. Shared so the rules can be tested without the app.

import { CONTEXT_WINDOW, WORKER_TASK_COMPACT, kTokens } from './context';
import { memTerms } from './memorySuggest';
import type { Task, Worker } from './types';

/**
 * A Worker at or above this context is not given new work by itself. It would be compacted before the new task
 * (from WORKER_TASK_COMPACT, src/shared/context.ts), which cuts most of the very context that made it worth reusing.
 */
export const REUSE_MAX_CONTEXT = Math.round(CONTEXT_WINDOW * 0.6);

/** Words shared with a Worker's past tasks before a task with no repository goes to it rather than to a new Worker. */
const MIN_RELATED_NO_REPO = 2;

export interface NewTask { title: string; prompt: string; kind: 'code' | 'other'; repo: string | null }

type W = Pick<Worker, 'id' | 'status' | 'repo' | 'model' | 'contextTokens' | 'taskIds' | 'lastActiveAt'>;
type T = Pick<Task, 'id' | 'title' | 'summary' | 'repo' | 'status' | 'workerId'>;

export interface Candidate<X extends W = W> {
  worker: X;
  score: number;
  /** Words the new task shares with this Worker's past tasks, most telling first. */
  related: string[];
  /** Its past tasks in the task's repository. */
  repoTasks: number;
}

// Words that say nothing about the area of the code. Short ASCII words (under 3 letters) are dropped too.
const STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'when', 'then', 'than', 'also', 'only', 'each', 'some', 'what',
  'which', 'have', 'has', 'not', 'but', 'are', 'was', 'were', 'will', 'can', 'should', 'make', 'use', 'used', 'using', 'add',
  'fix', 'update', 'change', 'new', 'all', 'any', 'one', 'two', 'its', 'their', 'them', 'they', 'you', 'your', 'our', 'more',
  'task', 'tasks', 'please', 'done', 'test', 'tests', 'code', 'src', 'main', 'file', 'files', 'run', 'pass', 'https', 'http',
  'com', 'github', 'pull', 'branch', 'repo', 'repository', 'open', 'push', 'commit', 'npm', 'typecheck', 'build', 'lint',
  '수정', '추가', '작업', '확인', '해주세요', '주세요', '그리고', '있는', '없는', '하는', '하고', '위한', '경우', '기능', '지금', '현재',
]);

/** Words that can tell two tasks are about the same part of the code. */
export function keywords(text: string): Set<string> {
  return new Set(memTerms(text).filter((w) => !STOP.has(w) && !/^\d+$/.test(w) && (w.length >= 3 || /[^\x00-\x7f]/.test(w))));
}

/** Open work keeps a Worker from taking more: a task running, waiting for an answer, queued, or waiting for a merge. */
const OPEN = new Set<Task['status']>(['running', 'waiting', 'queued', 'blocked']);

/** Why a Worker cannot take new work by itself right now, in English for the Dispatcher; null when it can. */
export function reuseBlock(w: W, tasks: T[]): string | null {
  if (w.status === 'archived') return 'archived';
  if (w.status !== 'idle') return w.status === 'error' ? 'stopped with an error' : 'busy';
  if (tasks.some((x) => x.workerId === w.id && OPEN.has(x.status))) return 'has open work';
  if (w.contextTokens >= REUSE_MAX_CONTEXT) return `context ${kTokens(w.contextTokens)} is near compaction`;
  return null;
}

/** The "New work" line of list_workers: whether the Worker can take a task, and that it is compacted first. */
export function newWorkLine(w: W, tasks: T[]): string {
  const block = reuseBlock(w, tasks);
  if (block) return block;
  return w.contextTokens >= WORKER_TASK_COMPACT ? `can take it (context ${kTokens(w.contextTokens)} is compacted before it starts)` : 'can take it';
}

/**
 * Idle Workers that can take the task, best first. They run the same model, hold no open work, and have room in their context.
 * A code task needs the Worker's own repository (its worktree); another task with a repository needs a Worker that worked there;
 * a task with no repository needs one whose past tasks share a few words with it.
 * Score: shared words (the area), then past tasks in the repository, then recent activity, less a little for a fuller context.
 */
export function rankWorkers<X extends W>(workers: X[], tasks: T[], nt: NewTask, model: string, now = Date.now()): Candidate<X>[] {
  const want = keywords(`${nt.title}\n${nt.prompt.slice(0, 4000)}`);
  const out: Candidate<X>[] = [];
  for (const w of workers) {
    if (w.model !== model || reuseBlock(w, tasks)) continue;
    const own = tasks.filter((x) => x.workerId === w.id);
    const repoTasks = nt.repo ? own.filter((x) => x.repo === nt.repo).length : 0;
    if (nt.kind === 'code' && (!nt.repo || w.repo !== nt.repo)) continue;
    if (nt.kind === 'other' && nt.repo && w.repo !== nt.repo && !repoTasks) continue;
    const seen = keywords(own.map((x) => `${x.title}\n${x.summary ?? ''}`).join('\n'));
    // Longer words first: "prmonitor" says more than "pr".
    const related = [...want].filter((k) => seen.has(k)).sort((a, b) => b.length - a.length);
    if (!nt.repo && related.length < MIN_RELATED_NO_REPO) continue;
    const idleHours = (now - Date.parse(w.lastActiveAt)) / 3600_000;
    const recent = idleHours <= 24 ? 2 : idleHours <= 72 ? 1 : 0;
    const score = 2 * Math.min(related.length, 6) + Math.min(repoTasks, 4) + recent - w.contextTokens / 50_000;
    out.push({ worker: w, score, related, repoTasks });
  }
  return out.sort((a, b) => b.score - a.score || a.worker.contextTokens - b.worker.contextTokens || b.worker.lastActiveAt.localeCompare(a.worker.lastActiveAt));
}

/** The Worker to reuse, or null to create a new one. */
export function pickWorker<X extends W>(workers: X[], tasks: T[], nt: NewTask, model: string, now = Date.now()): Candidate<X> | null {
  return rankWorkers(workers, tasks, nt, model, now)[0] ?? null;
}

/** Why this Worker got the task, for the Dispatcher. */
export function describePick(c: Candidate, repo: string | null): string {
  const parts = [
    repo ? `knows ${repo} from ${c.repoTasks} task(s)` : 'did related work',
    c.related.length ? `related: ${c.related.slice(0, 4).join(', ')}` : '',
    `context ${kTokens(c.worker.contextTokens)}`,
  ];
  return parts.filter(Boolean).join('; ');
}
