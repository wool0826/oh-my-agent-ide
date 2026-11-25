// The look back in a Worker's Summary tab: where each task's time went (waiting to start, running, waiting for the
// user, waiting for the Dispatcher), the last seven days' totals, and the permission decisions. Also the records it
// reads: each task's status history and its permission decisions, kept on the task because answered decisions are
// dropped after a day.

import { addSpend, type Spend } from './spend';
import { ALLOW, ALLOW_TASK, DENY, GRANT_USED, type PermissionMark, type Task, type TaskMark, type TaskStatus } from './types';

/** Marks kept per task; the oldest go first past this. */
export const KEEP_MARKS = 200;

const ACTIVE: ReadonlySet<TaskStatus> = new Set(['blocked', 'queued', 'running', 'waiting']);
const ENDED: ReadonlySet<TaskStatus> = new Set(['pr_open', 'done', 'failed', 'cancelled']);
const MIN = 60_000;

const keep = <T>(list: T[]) => (list.length > KEEP_MARKS ? list.slice(list.length - KEEP_MARKS) : list);
const markOf = (x: Pick<Task, 'status' | 'waitingOn'>): Omit<TaskMark, 'at'> => (x.status === 'waiting' && x.waitingOn === 'dispatcher' ? { status: x.status, on: 'dispatcher' } : { status: x.status });

/** The history a new task starts with. */
export function firstMarks(status: TaskStatus, at: string): TaskMark[] {
  return [{ status, at }];
}

/**
 * Note the status of every task that keeps a history, when it differs from the last mark (a waiting task also by
 * whom it waits for). Tasks made before histories existed keep none. Says whether anything changed.
 */
export function stampHistory(tasks: Pick<Task, 'status' | 'waitingOn' | 'history'>[], at: string): boolean {
  let changed = false;
  for (const x of tasks) {
    if (!x.history) continue;
    const last = x.history[x.history.length - 1];
    const now = markOf(x);
    if (last && last.status === now.status && (last.on ?? null) === (now.on ?? null)) continue;
    x.history = keep([...x.history, { ...now, at }]);
    changed = true;
  }
  return changed;
}

/**
 * The task's permission decisions with one more. Past KEEP_MARKS the oldest rule use goes first, so a rule used many
 * times does not push out the user's own answers; then the oldest answer.
 */
export function withPermission(list: readonly PermissionMark[] | null | undefined, mark: PermissionMark): PermissionMark[] {
  const out = [...(list ?? []), mark];
  while (out.length > KEEP_MARKS) {
    const rule = out.findIndex((p) => p.answer === GRANT_USED);
    out.splice(rule === -1 ? 0 : rule, 1);
  }
  return out;
}

/** Minutes a task spent in each state, not rounded: a task of seconds still has a time line. */
export interface TaskTimes {
  /** Waiting to start: queued or blocked, the first time and any later time. */
  queue: number;
  run: number;
  /** Waiting for the user's answer. */
  you: number;
  /** Waiting for the Dispatcher's answer. */
  dispatcher: number;
}

const span = (from: string | null | undefined, to: number) => {
  const ms = to - Date.parse(from ?? '');
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
};
const waitedMs = (p: PermissionMark) => (p.answeredAt ? span(p.at, Date.parse(p.answeredAt)) : 0);
const mins = (ms: number) => ms / MIN;

/**
 * Where a task's time went, up to `now` while it is still open. From its history when it has one. A task made before
 * histories existed gives what its times say: created to started is waiting, started to finished is running less its
 * answered permissions, and nothing is known of the Dispatcher. Null when there is nothing to tell (never started).
 */
export function taskTimes(x: Pick<Task, 'status' | 'createdAt' | 'startedAt' | 'finishedAt' | 'history' | 'permissions'>, now = Date.now()): TaskTimes | null {
  const h = x.history;
  if (h?.length) {
    const out = { queue: 0, run: 0, you: 0, dispatcher: 0 };
    h.forEach((m, i) => {
      const end = i + 1 < h.length ? Date.parse(h[i + 1].at) : ACTIVE.has(m.status) ? now : NaN;
      const ms = Number.isFinite(end) ? span(m.at, end) : 0;
      if (m.status === 'queued' || m.status === 'blocked') out.queue += ms;
      else if (m.status === 'running') out.run += ms;
      else if (m.status === 'waiting') out[m.on === 'dispatcher' ? 'dispatcher' : 'you'] += ms;
    });
    return { queue: mins(out.queue), run: mins(out.run), you: mins(out.you), dispatcher: mins(out.dispatcher) };
  }
  if (!x.startedAt) return ACTIVE.has(x.status) ? { queue: mins(span(x.createdAt, now)), run: 0, you: 0, dispatcher: 0 } : null;
  const end = x.finishedAt && !ACTIVE.has(x.status) ? Date.parse(x.finishedAt) : ACTIVE.has(x.status) ? now : Date.parse(x.startedAt);
  const ran = span(x.startedAt, end);
  const you = Math.min(ran, (x.permissions ?? []).reduce((a, p) => a + waitedMs(p), 0));
  return { queue: mins(span(x.createdAt, Date.parse(x.startedAt))), run: mins(ran - you), you: mins(you), dispatcher: 0 };
}

export const totalMinutes = (t: TaskTimes) => t.queue + t.run + t.you + t.dispatcher;

/** How many times the task was worked on: once, plus each time it went back to work after it had ended (review comments, CI, a follow-up). */
export function taskRounds(x: Pick<Task, 'history'>): number {
  const h = x.history ?? [];
  let n = 1;
  for (let i = 1; i < h.length; i++) if (ENDED.has(h[i - 1].status) && ACTIVE.has(h[i].status)) n++;
  return n;
}

/** Times failed CI was sent to the Worker to fix. */
export const ciRetries = (x: Pick<Task, 'ciFixTotal' | 'ciFixAttempts'>) => x.ciFixTotal ?? x.ciFixAttempts ?? 0;

export type Outcome = 'success' | 'failed' | 'stopped' | 'open' | 'cancelled';

/** Done or with a PR is a success; a failure the user caused with Stop is apart from one that went wrong. */
export function outcome(x: Pick<Task, 'status' | 'stopped'>): Outcome {
  if (x.status === 'done' || x.status === 'pr_open') return 'success';
  if (x.status === 'failed') return x.stopped ? 'stopped' : 'failed';
  if (x.status === 'cancelled') return 'cancelled';
  return 'open';
}

export interface Span { from: number; to: number }

/** The last seven days, today included, from local midnight six days ago to `now`. */
export function lastWeek(now = Date.now()): Span {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - 6);
  return { from: d.getTime(), to: now };
}

/** When a task last counted: when it finished, or its last change while it is still open. */
export const taskAt = (x: Pick<Task, 'status' | 'finishedAt' | 'updatedAt'>) => Date.parse((!ACTIVE.has(x.status) && x.finishedAt) || x.updatedAt);

const inSpan = (ms: number, s: Span) => ms >= s.from && ms <= s.to;

/** The tasks of a span, newest first: those that finished in it, and open ones changed in it. A task cancelled before it started is left out. */
export function spanTasks(tasks: readonly Task[], s: Span): Task[] {
  return tasks
    .filter((x) => !(x.status === 'cancelled' && !x.startedAt) && inSpan(taskAt(x), s))
    .sort((a, b) => taskAt(b) - taskAt(a));
}

/** allow / task: allowed once or for the task; rule: let through by an allow-for-this-task rule; deny / note: denied, plainly or with words. */
export type PermKind = 'allow' | 'task' | 'rule' | 'deny' | 'note';

export function permKind(answer: string): PermKind {
  if (answer === ALLOW) return 'allow';
  if (answer === ALLOW_TASK) return 'task';
  if (answer === GRANT_USED) return 'rule';
  if (answer === DENY) return 'deny';
  return 'note';
}

export interface PermRow {
  taskId: string;
  workerId: string | null;
  title: string;
  at: string;
  code: string;
  kind: PermKind;
  /** What the user said when denying with words. */
  note: string | null;
  /** Minutes the answer took; null for a rule's use. */
  wait: number | null;
}

/** The permission decisions of these tasks, newest first; only those asked within the span when one is given. */
export function permissionRows(tasks: readonly Task[], s?: Span): PermRow[] {
  const rows: PermRow[] = [];
  for (const x of tasks) {
    for (const p of x.permissions ?? []) {
      if (s && !inSpan(Date.parse(p.at), s)) continue;
      const kind = permKind(p.answer);
      rows.push({ taskId: x.id, workerId: x.workerId, title: x.title, at: p.at, code: p.code, kind, note: kind === 'note' ? p.answer : null, wait: p.answeredAt ? Math.round(mins(waitedMs(p))) : null });
    }
  }
  return rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

export type PermFilter = 'all' | 'allowed' | 'denied';

const ALLOWED: ReadonlySet<PermKind> = new Set(['allow', 'task', 'rule']);

export function filterPerms(rows: readonly PermRow[], f: PermFilter): PermRow[] {
  return f === 'all' ? [...rows] : rows.filter((r) => ALLOWED.has(r.kind) === (f === 'allowed'));
}

/** Decisions the user made: a rule's use is not one. */
export function permCounts(rows: readonly PermRow[]): { allowed: number; denied: number } {
  let allowed = 0, denied = 0;
  for (const r of rows) {
    if (r.kind === 'allow' || r.kind === 'task') allowed++;
    else if (r.kind === 'deny' || r.kind === 'note') denied++;
  }
  return { allowed, denied };
}

export interface RetroTotals {
  tasks: number;
  /** Succeeded or failed; stopped, open and cancelled tasks are left out. */
  finished: number;
  succeeded: number;
  spend: Spend | null;
  ciRetries: number;
  /** Tasks with at least one CI retry. */
  ciTasks: number;
  /** Finished tasks worked on more than once. */
  again: number;
  /** Minutes the tasks waited for the user, and ran, not rounded. */
  you: number;
  run: number;
  allowed: number;
  denied: number;
}

/** Totals over some tasks and the permission decisions given. */
export function retroTotals(tasks: readonly Task[], perms: readonly PermRow[], now = Date.now()): RetroTotals {
  const out: RetroTotals = { tasks: tasks.length, finished: 0, succeeded: 0, spend: null, ciRetries: 0, ciTasks: 0, again: 0, you: 0, run: 0, ...permCounts(perms) };
  for (const x of tasks) {
    const o = outcome(x);
    if (o === 'success' || o === 'failed') {
      out.finished++;
      if (o === 'success') out.succeeded++;
      if (taskRounds(x) > 1) out.again++;
    }
    if (x.spend) out.spend = addSpend(out.spend, x.spend);
    const ci = ciRetries(x);
    out.ciRetries += ci;
    if (ci > 0) out.ciTasks++;
    const tm = taskTimes(x, now);
    if (tm) { out.you += tm.you; out.run += tm.run; }
  }
  return out;
}

/** n of total as a whole percent; 0 of 0 is 0. */
export const percent = (n: number, total: number) => (total ? Math.round((n / total) * 100) : 0);
