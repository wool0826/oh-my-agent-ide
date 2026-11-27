// Which Worker takes a new task when the Dispatcher does not name one: an idle Worker that already knows the
// repository (and, better, the same area of it), with nothing else open. A fuller context costs it a little, never
// the task by itself: the Worker is compacted before the task starts. A new Worker is created only when none fits.
// Shared so the rules can be tested without the app.

import { CONTEXT_WINDOW, WORKER_TASK_COMPACT, kTokens } from './context';
import { memTerms } from './memorySuggest';
import { providerOf } from './models';
import type { Task, Worker } from './types';

/**
 * Whether the app compacts a Worker on this model before it starts a new task (queue.startTask, compactFirst from
 * WORKER_TASK_COMPACT): a Claude Code session is; a Codex thread is not, it compacts by itself as the context fills.
 */
export const compactsBeforeTask = (model: string) => providerOf(model) === 'claude';

/**
 * A Worker that cannot be compacted before a new task (Codex) is not given new work by itself from this context: it
 * would carry it into the task and be compacted in the middle of it. A Worker compacted first has no such limit.
 */
export const REUSE_MAX_CONTEXT = Math.round(CONTEXT_WINDOW * 0.6);

/**
 * A compaction that started longer ago than this no longer blocks the Worker: one whose end never arrived (a Codex
 * thread that went quiet) must not keep it from work until a restart.
 */
export const COMPACT_STALE_MS = 15 * 60_000;

/** What compacting before the task costs in the ranking: one more turn, and the detail the summary drops. */
const COMPACT_COST = 1;

/**
 * How much a Worker's context counts against it. Carried into the task as it is, it costs 1 per 50K. Compacted first
 * (from 60K), the task starts from a summary of 23K to 49K whatever the size, so it costs the compaction plus a little
 * for its length (1.6 at 60K, 2.5 at 150K, 3 at 200K). Unrelated context is worse only because it earns no "related" points.
 */
export function contextCost(w: Pick<Worker, 'model' | 'contextTokens'>) {
  if (compactsBeforeTask(w.model) && w.contextTokens >= WORKER_TASK_COMPACT) return COMPACT_COST + w.contextTokens / 100_000;
  return w.contextTokens / 50_000;
}

/** Words shared with a Worker's past tasks before a task with no repository goes to it rather than to a new Worker. */
const MIN_RELATED_NO_REPO = 2;

export interface NewTask { title: string; prompt: string; kind: 'code' | 'other'; repo: string | null }

type W = Pick<Worker, 'id' | 'status' | 'repo' | 'model' | 'contextTokens' | 'taskIds' | 'lastActiveAt' | 'compactingSince'>;
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

/** Whether the Worker is compacted before a new task starts: its context is summarized first. */
const compactedFirst = (w: Pick<Worker, 'model' | 'contextTokens'>) => compactsBeforeTask(w.model) && w.contextTokens >= WORKER_TASK_COMPACT;

/**
 * Why a Worker cannot take new work by itself right now, in English for the Dispatcher; null when it can. Its context
 * size alone is no reason: only a compaction under way, or a context that cannot be compacted before the task (T-0154).
 */
export function reuseBlock(w: W, tasks: T[], now = Date.now()): string | null {
  if (w.status === 'archived') return 'archived';
  if (w.compactingSince && now - Date.parse(w.compactingSince) < COMPACT_STALE_MS) return 'compacting its context';
  if (w.status !== 'idle') return w.status === 'error' ? 'stopped with an error' : 'busy';
  if (tasks.some((x) => x.workerId === w.id && OPEN.has(x.status))) return 'has open work';
  if (!compactsBeforeTask(w.model) && w.contextTokens >= REUSE_MAX_CONTEXT) return `context ${kTokens(w.contextTokens)} cannot be compacted before it starts`;
  return null;
}

/** The "New work" line of list_workers: whether the Worker can take a task, and that it is compacted first. */
export function newWorkLine(w: W, tasks: T[], now = Date.now()): string {
  const block = reuseBlock(w, tasks, now);
  if (block) return block;
  return compactedFirst(w) ? `can take it (context ${kTokens(w.contextTokens)} is compacted before it starts)` : 'can take it';
}

/**
 * Idle Workers that can take the task, best first. They run the same model and hold no open work.
 * A code task needs the Worker's own repository (its worktree); another task with a repository needs a Worker that worked there;
 * a task with no repository needs one whose past tasks share a few words with it.
 * Score: shared words (the area), then past tasks in the repository, then recent activity, less contextCost.
 */
export function rankWorkers<X extends W>(workers: X[], tasks: T[], nt: NewTask, model: string, now = Date.now()): Candidate<X>[] {
  const want = keywords(`${nt.title}\n${nt.prompt.slice(0, 4000)}`);
  const out: Candidate<X>[] = [];
  for (const w of workers) {
    if (w.model !== model || reuseBlock(w, tasks, now)) continue;
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
    const score = 2 * Math.min(related.length, 6) + Math.min(repoTasks, 4) + recent - contextCost(w);
    out.push({ worker: w, score, related, repoTasks });
  }
  return out.sort((a, b) => b.score - a.score || a.worker.contextTokens - b.worker.contextTokens || b.worker.lastActiveAt.localeCompare(a.worker.lastActiveAt));
}

/** The Worker to reuse, or null to create a new one. */
export function pickWorker<X extends W>(workers: X[], tasks: T[], nt: NewTask, model: string, now = Date.now()): Candidate<X> | null {
  return rankWorkers(workers, tasks, nt, model, now)[0] ?? null;
}

/**
 * How a new task is handed out (T-0146). now: a Worker takes it at once. blocked, slot, limit: it waits for another
 * task (after_task_id), a free Worker slot or a free account without a Worker, so no idle Worker is held for it; one is
 * picked when it can start (startWorker). A task pinned to a Worker (worker_id, or new_worker) is handed out now and
 * waits on that Worker as before.
 */
export type Handout = 'now' | 'blocked' | 'slot' | 'limit';

export function lateBind(a: { pinned: boolean; after: boolean; slotFree: boolean; accountFree: boolean }): Handout {
  if (a.pinned) return 'now';
  if (a.after) return 'blocked';
  if (!a.slotFree) return 'slot';
  if (!a.accountFree) return 'limit';
  return 'now';
}

/**
 * The Worker a task that waited unassigned starts on: the Worker of the task it waited for, when that one can take it
 * by the same rules as any other (it has the context and the branch history), else the best one, else null for a new one.
 */
export function startWorker<X extends W>(workers: X[], tasks: T[], nt: NewTask, model: string, preferId: string | null, now = Date.now()): Candidate<X> | null {
  const ranked = rankWorkers(workers, tasks, nt, model, now);
  return ranked.find((c) => c.worker.id === preferId) ?? ranked[0] ?? null;
}

/** Why this Worker got the task, for the Dispatcher. */
export function describePick(c: Candidate, repo: string | null): string {
  const parts = [
    repo ? `knows ${repo} from ${c.repoTasks} task(s)` : 'did related work',
    c.related.length ? `related: ${c.related.slice(0, 4).join(', ')}` : '',
    `context ${kTokens(c.worker.contextTokens)}${compactedFirst(c.worker) ? ', compacted before it starts' : ''}`,
  ];
  return parts.filter(Boolean).join('; ');
}
