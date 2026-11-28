// @ mentions (decision 7C): "@" after a space or at the start of the text lists the repositories, files, PRs, tasks
// and Workers, and the one picked becomes a chip over the composer's text. The chips go with the message as a
// "[Mentioned]" block after the text (as attached files do), so the Dispatcher or the Worker reads what was meant and
// the thread draws them again as chips over the sent message.

import type { Mention, MentionKind, Repo, Task, Worker } from './types';

/** Rows per group with nothing typed after "@", and with something typed. */
export const MENTION_GROUP_MAX = { empty: 3, typed: 4, files: 6 } as const;
/** Mention chips shown over the text before the rest fold into "+N". */
export const MENTION_CHIPS_SHOWN = 4;
/** The files of one repository the index keeps. */
export const MENTION_FILES_MAX = 50_000;

/** The order of the groups in the list. */
export const MENTION_KINDS: readonly MentionKind[] = ['repo', 'file', 'pr', 'task', 'worker'];

/** The "@" being typed at the caret: at the start of the text or after a space, while what follows it has no space. */
export function mentionAt(value: string, caret: number): { start: number; query: string } | null {
  const before = value.slice(0, caret);
  const m = /(^|\s)@([^\s@]*)$/.exec(before);
  if (!m) return null;
  return { start: caret - m[2].length - 1, query: m[2] };
}

/** The composer's text without the "@" being typed, and where the caret goes. */
export function dropMention(value: string, at: { start: number; query: string }): { value: string; caret: number } {
  return { value: value.slice(0, at.start) + value.slice(at.start + 1 + at.query.length), caret: at.start };
}

/** A PR's number from its URL, or null. */
export function prNumber(url: string | null | undefined): number | null {
  const m = /\/pull\/(\d+)/.exec(url ?? '');
  return m ? Number(m[1]) : null;
}

/** Where a repository is, as the list says it: its parent folder, or "GitHub" for a clone the app keeps itself. */
export function repoWhere(r: Pick<Repo, 'path' | 'url'>, ownDir: string): string {
  const own = ownDir && r.path.toLowerCase().startsWith(ownDir.toLowerCase());
  if (own) return /github\.com/i.test(r.url) ? 'GitHub' : (/^(?:https?:\/\/|git@)([^/:]+)/.exec(r.url)?.[1] ?? '');
  const i = Math.max(r.path.lastIndexOf('/'), r.path.lastIndexOf('\\'));
  return i > 0 ? r.path.slice(0, i) : r.path;
}

export interface MentionFile { repo: string; path: string }

export interface MentionSources {
  repos: readonly (Pick<Repo, 'name'> & { where: string })[];
  files: readonly MentionFile[];
  tasks: readonly Pick<Task, 'id' | 'title' | 'repo' | 'workerId' | 'status' | 'prUrl' | 'prState' | 'updatedAt'>[];
  workers: readonly Pick<Worker, 'id' | 'title' | 'status' | 'taskIds'>[];
}

/** A row of the list: the mention it makes, and what the row shows beside its label. */
export interface MentionRow { mention: Mention; meta: string; state?: string }

const fileName = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const fileDir = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/** Those whose key starts with the query first, then those that hold it; all when nothing is typed. */
function rank<T>(list: readonly T[], q: string, keys: (x: T) => string[]): T[] {
  if (!q) return [...list];
  const low = (x: T) => keys(x).map((k) => k.toLowerCase());
  const first = list.filter((x) => low(x).some((k) => k.startsWith(q)));
  const then = list.filter((x) => !first.includes(x) && low(x).some((k) => k.includes(q)));
  return [...first, ...then];
}

const DONE: Task['status'][] = ['done', 'cancelled', 'failed'];

/**
 * The rows for a query, by group in MENTION_KINDS order. Files only once something is typed. Tasks and PRs newest
 * first; Workers that are archived are left out. `done`: what a finished task or a merged PR says in place of its
 * Worker or repository.
 */
export function mentionRows(src: MentionSources, query: string, words: { done: string; merged: string; closed: string }): Record<MentionKind, MentionRow[]> {
  const q = query.toLowerCase();
  const max = q ? MENTION_GROUP_MAX.typed : MENTION_GROUP_MAX.empty;
  const recent = [...src.tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const repos = rank(src.repos, q, (r) => [r.name]).slice(0, max)
    .map((r): MentionRow => ({ mention: { kind: 'repo', id: r.name, label: r.name }, meta: r.where }));
  const files = q
    ? rank(src.files, q, (f) => [fileName(f.path), f.path]).slice(0, MENTION_GROUP_MAX.files)
      .map((f): MentionRow => ({ mention: { kind: 'file', id: f.path, label: fileName(f.path), repo: f.repo }, meta: fileDir(f.path) || f.repo }))
    : [];
  const prTasks = recent.filter((t) => prNumber(t.prUrl) !== null);
  const prs = rank(prTasks, q, (t) => [`#${prNumber(t.prUrl)}`, String(prNumber(t.prUrl)), t.title]).slice(0, max)
    .map((t): MentionRow => ({
      mention: { kind: 'pr', id: t.prUrl!, label: `#${prNumber(t.prUrl)}`, title: t.title, repo: t.repo ?? undefined },
      meta: t.prState === 'MERGED' ? words.merged : t.prState === 'CLOSED' ? words.closed : t.repo ?? '',
      state: t.prState === 'MERGED' ? 'merged' : 'open',
    }));
  const tasks = rank(recent, q, (t) => [t.id, t.title]).slice(0, max)
    .map((t): MentionRow => ({ mention: { kind: 'task', id: t.id, label: t.id, title: t.title }, meta: DONE.includes(t.status) ? words.done : t.workerId ?? '', state: t.status }));
  const live = src.workers.filter((w) => w.status !== 'archived');
  const taskOf = (w: (typeof live)[number]) => src.tasks.find((t) => t.id === w.taskIds[w.taskIds.length - 1])?.title ?? w.title;
  const workers = rank(live, q, (w) => [w.id, w.title, taskOf(w)]).slice(0, max)
    .map((w): MentionRow => ({ mention: { kind: 'worker', id: w.id, label: w.id }, meta: taskOf(w) }));
  return { repo: repos, file: files, pr: prs, task: tasks, worker: workers };
}

/** The chips once one more is picked: the same mention is not there twice. */
export function addMention(list: readonly Mention[], m: Mention): Mention[] {
  return list.some((x) => x.kind === m.kind && x.id === m.id && x.repo === m.repo) ? [...list] : [...list, m];
}

/** The chips shown and how many fold into "+N". */
export function chipFold<T>(list: readonly T[], open: boolean, shown = MENTION_CHIPS_SHOWN): { shown: T[]; more: number } {
  if (open || list.length <= shown + 1) return { shown: [...list], more: 0 };
  return { shown: list.slice(0, shown), more: list.length - shown };
}

const WORD: Record<MentionKind, string> = { repo: 'repository', file: 'file', pr: 'PR', task: 'task', worker: 'Worker' };
const KIND_OF: Record<string, MentionKind> = { repository: 'repo', file: 'file', PR: 'pr', task: 'task', Worker: 'worker' };
const MARK = '\n\n[Mentioned]\n';

/** A mention as the agent reads it, on one line. `detail` is anything that helps find it (a folder, a URL). */
function mentionLine(m: Mention): string {
  const clean = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();
  const head = m.kind === 'file' ? m.id : m.label;
  const extra = [m.title, m.kind === 'pr' ? m.id : '', m.kind !== 'repo' ? m.repo : '', m.detail].filter(Boolean).map((s) => clean(s!));
  return `- ${WORD[m.kind]} ${clean(head)}${extra.length ? ` (${extra.join('; ')})` : ''}`;
}

/** The block a message with mentions ends with. */
export function mentionBlock(list: readonly Mention[]): string {
  return list.length ? MARK + list.map(mentionLine).join('\n') : '';
}

/** A sent message's own text and the chips its "[Mentioned]" block names (kind and label only). */
export function splitMentions(text: string): { text: string; mentions: Pick<Mention, 'kind' | 'label'>[] } {
  const i = text.indexOf(MARK);
  if (i < 0) return { text, mentions: [] };
  const rest = text.slice(i + MARK.length);
  // The block runs to the attached files, if any.
  const j = rest.indexOf('\n\n');
  const block = j < 0 ? rest : rest.slice(0, j);
  const mentions = block.split('\n').map((line) => {
    const m = /^- (repository|file|PR|task|Worker) (.+?)(?: \(.*\))?$/.exec(line);
    if (!m) return null;
    const kind = KIND_OF[m[1]];
    return { kind, label: kind === 'file' ? fileName(m[2]) : m[2] };
  }).filter((x): x is Pick<Mention, 'kind' | 'label'> => !!x);
  return { text: text.slice(0, i) + (j < 0 ? '' : rest.slice(j)), mentions };
}
