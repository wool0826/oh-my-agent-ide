import type { Task, TaskOverlap } from './types';

/**
 * Files a new task will meet in work already under way: the paths its prompt names against the files that tasks in
 * progress on the same repository have changed on their branches (Task.changedFiles, read from git at turn ends).
 * A warning for the Dispatcher only; nothing is blocked.
 */

/** Regenerated, not merged by hand: two branches changing one is no reason to order them. */
const LOCKFILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'Cargo.lock', 'poetry.lock', 'Gemfile.lock', 'composer.lock', 'go.sum']);

/** Files listed per overlapping task, in the tool result and on the Workers view. */
const MAX_FILES = 5;
const MAX_TASKS = 3;

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/**
 * File paths a prompt names: repository paths (`src/shared/i18n.ts`) and bare file names (`gitwork.ts`), with
 * backslashes as slashes. Absolute paths (outside the repository), URLs and paths without an extension are left out.
 */
export function promptPaths(prompt: string): string[] {
  const out = new Set<string>();
  for (const raw of prompt.split(/[\s`'"()<>[\]{},;|*]+/)) {
    if (!raw || /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /^[a-z]:[\\/]/i.test(raw)) continue;
    // Trailing sentence marks and a ":12" line number are not part of the path.
    const p = raw.replace(/\\/g, '/').replace(/[.:!?]+$/, '').replace(/(:\d+)+$/, '').replace(/^(\.\/|\/)+/, '');
    // A file name ends in an extension that starts with a letter (".gitignore" too); "0.7.0" and "W-04" are not files.
    if (!/^[\w@.+-]+(\/[\w@.+-]+)*$/.test(p) || !/\.[a-z][a-z0-9]*$/i.test(p) || p.split('/').includes('..')) continue;
    out.add(p);
  }
  return [...out];
}

/** A named path meets a changed file: the same path, or the file ends with it at a folder boundary (a bare name matches by name). */
export function pathMeets(named: string, file: string) {
  return file === named || file.endsWith(`/${named}`);
}

/** A task whose branch work counts: not finished, its PR (if any) still open, its changed files known. */
function inProgress(t: Task) {
  return (t.status === 'running' || t.status === 'waiting' || t.status === 'pr_open' || t.status === 'queued' || t.status === 'blocked')
    && t.prState !== 'MERGED' && t.prState !== 'CLOSED' && !!t.changedFiles?.length;
}

export interface OverlapQuery {
  /** The new task itself, left out of the comparison. */
  id?: string;
  repo: string | null;
  /** Paths its prompt names (promptPaths). */
  paths: string[];
  /** after_task_id: that task is already ordered before this one, so meeting it needs no mention. */
  after?: string | null;
  /** A comparison attempt meets its twin on purpose. */
  compareGroup?: string | null;
}

/**
 * The tasks in progress on the same repository whose branches already change files the new task's prompt names,
 * each with those files (sorted, lockfiles left out). The most files first; at most three tasks.
 */
export function findOverlaps(q: OverlapQuery, tasks: Task[]): TaskOverlap[] {
  if (!q.repo || !q.paths.length) return [];
  const out: TaskOverlap[] = [];
  for (const t of tasks) {
    if (t.id === q.id || t.repo !== q.repo || t.id === q.after || !inProgress(t)) continue;
    if (q.compareGroup && t.compare?.group === q.compareGroup) continue;
    const files = t.changedFiles!.filter((f) => !LOCKFILES.has(baseName(f)) && q.paths.some((p) => pathMeets(p, f)));
    if (files.length) out.push({ taskId: t.id, files: [...new Set(files)].sort() });
  }
  return out.sort((a, b) => b.files.length - a.files.length).slice(0, MAX_TASKS);
}

const listFiles = (files: string[], name: (f: string) => string) =>
  files.slice(0, MAX_FILES).map(name).join(', ') + (files.length > MAX_FILES ? ` +${files.length - MAX_FILES}` : '');

/**
 * What create_task tells the Dispatcher about a new task's overlaps: which tasks already change which files, and how
 * to order the new task after one of them. '' when there is none.
 */
export function overlapNote(next: Pick<Task, 'id' | 'status' | 'workerId'>, overlaps: TaskOverlap[], tasks: Task[]): string {
  if (!overlaps.length) return '';
  const lines = overlaps.map((o) => {
    const t = tasks.find((x) => x.id === o.taskId);
    const where = t ? ` "${t.title}" (${[t.workerId, t.status === 'pr_open' ? 'PR open' : t.status].filter(Boolean).join(', ')})` : '';
    return `${o.taskId}${where} already changes ${listFiles(o.files, (f) => f)}.`;
  });
  const first = overlaps[0].taskId;
  const undo = next.status === 'queued' || next.status === 'blocked' ? 'cancel_task it' : `stop_worker ${next.workerId ?? 'its Worker'}`;
  return ` Overlap: ${lines.join(' ')} If ${next.id} must build on that work, ${undo} and create it again with after_task_id "${first}"; otherwise tell both Workers which files they share.`;
}

/** The overlaps a task's Workers view shows in one line, by file name; '' once the task is finished or has none. */
export function overlapLine(task: Task): string {
  if (!task.overlaps?.length || task.status === 'done' || task.status === 'failed' || task.status === 'cancelled') return '';
  return task.overlaps.map((o) => `${o.taskId} ${listFiles(o.files, baseName)}`).join(' · ');
}
