// Exporting a Worker's work as Markdown (item 12A): copied, saved as a .md file or published as an artifact.
// The text is written for sharing, so credentials (shared/diagnostics.ts) and the user's name in home folder paths are
// hidden here, in one place, and counted for the publish dialog.
import { redactCount } from './diagnostics';
import type { DiffFile, PrChecks, Task, WorkerLogItem } from './types';

export type ExportPart = 'chat' | 'report' | 'diff' | 'shots';
/** The parts in the order the dialog lists them. */
export const EXPORT_PARTS: ExportPart[] = ['chat', 'report', 'diff', 'shots'];
/** Screenshots are off until picked: they are files on this computer, and a page shows them only once uploaded. */
export const EXPORT_DEFAULT: ExportPart[] = ['chat', 'report', 'diff'];

export type ExportTask = Pick<Task, 'id' | 'title' | 'branch' | 'prUrl' | 'prState' | 'summary' | 'files'> & { links?: string[]; prChecks?: PrChecks | null };

/** What main gathers for one Worker. `tasks` oldest first; the last is the one the export is named after. */
export interface ExportSource {
  worker: { id: string; title: string; repo: string | null };
  tasks: ExportTask[];
  log: WorkerLogItem[];
  diff: DiffFile[];
  /** The user's home folder; its last part is hidden wherever a path names it. */
  home: string;
}

/** The words of the export, in the app's language. */
export interface ExportWords {
  report: string;
  chat: string;
  changes: string;
  shots: string;
  who: Record<Exclude<WorkerLogItem['from'], 'event'>, string>;
  ci: Record<PrChecks['ci'] | 'merged' | 'closed', string>;
  /** What stands in for a hidden value. */
  mask: string;
  time: (iso: string) => string;
  /** The line after a patch cut short: `n` lines left out. */
  more: (n: number) => string;
}

export interface ExportResult { md: string; hidden: { total: number; tokens: number; paths: number } }

/** Lines of one file's patch kept in an export; the rest is counted. */
export const PATCH_LINES = 400;

const SHOT = /\.(png|jpe?g|gif|webp)$/i;

/** The images the tasks' reports named, each once. */
export function exportShots(src: ExportSource): string[] {
  return [...new Set(src.tasks.flatMap((x) => x.files.filter((f) => SHOT.test(f))))];
}

const said = (src: ExportSource) => src.log.filter((x) => x.from !== 'event' && x.text.trim());

/** How much each part holds: messages, reports, changed files, screenshots. */
export function exportCounts(src: ExportSource): Record<ExportPart, number> {
  return {
    chat: said(src).length,
    report: src.tasks.filter((x) => x.summary?.trim()).length,
    diff: src.diff.length,
    shots: exportShots(src).length,
  };
}

export function prNumber(url: string | null | undefined): string | null {
  return url?.match(/\/pull\/(\d+)/)?.[1] ?? null;
}

/** "merged", "closed", or the open PR's CI state. */
function prWord(x: ExportTask, w: ExportWords): string {
  if (x.prState === 'MERGED') return w.ci.merged;
  if (x.prState === 'CLOSED') return w.ci.closed;
  return x.prChecks ? `CI ${w.ci[x.prChecks.ci]}` : '';
}

/** A fence the text inside cannot close. */
function fence(text: string): string {
  let f = '```';
  while (text.includes(f)) f += '`';
  return f;
}

function patchBlock(d: DiffFile, w: ExportWords): string {
  const lines = d.patch.replace(/\n$/, '').split('\n');
  const kept = lines.slice(0, PATCH_LINES).join('\n');
  const f = fence(kept);
  const head = `#### \`${d.path}\` +${d.added} −${d.removed}`;
  if (!d.patch.trim()) return head;
  return `${head}\n\n${f}diff\n${kept}\n${f}${lines.length > PATCH_LINES ? `\n\n${w.more(lines.length - PATCH_LINES)}` : ''}`;
}

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Paths in the home folder with its last part (the user's name) hidden, whichever slashes and case they use. */
export function hidePaths(text: string, home: string, mask: string): { text: string; n: number } {
  const parts = home.split(/[\\/]+/).filter(Boolean);
  const name = parts.pop();
  if (!name || name.length < 2) return { text, n: 0 };
  const sep = '[\\\\/]+';
  const lead = /^[\\/]/.test(home) ? sep : '';
  const re = new RegExp(`(${lead}${parts.map(escRe).map((p) => `${p}${sep}`).join('')})${escRe(name)}(?![\\w.-])`, 'gi');
  let n = 0;
  const out = text.replace(re, (_m, before: string) => { n++; return before + mask; });
  return { text: out, n };
}

/** A file path as a Markdown link target: forward slashes, and the characters that would end the link encoded. */
function shotLink(f: string): string {
  return f.replace(/\\/g, '/').replace(/[ ()[\]<>]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** The export: a heading for the latest task, its PR and branch, then the picked parts, with secrets hidden. */
export function exportMarkdown(src: ExportSource, parts: readonly ExportPart[], w: ExportWords): ExportResult {
  const on = new Set(parts);
  const x = src.tasks[src.tasks.length - 1];
  const out: string[] = [`## ${x ? `${x.id} ${x.title}` : `${src.worker.id} ${src.worker.title}`}`];
  const meta: string[] = [];
  const pr = prNumber(x?.prUrl);
  if (x?.prUrl) meta.push(`- ${[pr ? `PR #${pr}` : 'PR', prWord(x, w), x.prUrl].filter(Boolean).join(' · ')}`);
  meta.push(`- ${[src.worker.id, src.worker.repo, x?.branch].filter(Boolean).join(' · ')}`);
  out.push(meta.join('\n'));
  if (on.has('report')) {
    const done = src.tasks.filter((t) => t.summary?.trim());
    if (done.length) {
      out.push(`### ${w.report}`);
      for (const t of done) {
        if (done.length > 1) out.push(`#### ${t.id} ${t.title}`);
        out.push(t.summary!.trim());
        if (t.links?.length) out.push(t.links.map((l) => `- ${l}`).join('\n'));
      }
    }
  }
  if (on.has('chat')) {
    const items = said(src);
    if (items.length) {
      out.push(`### ${w.chat}`);
      for (const m of items) out.push(`**${w.who[m.from as keyof ExportWords['who']]}** · ${w.time(m.ts)}\n\n${m.text.trim()}`);
    }
  }
  if (on.has('diff') && src.diff.length) {
    out.push(`### ${w.changes}`);
    for (const d of src.diff) out.push(patchBlock(d, w));
  }
  if (on.has('shots')) {
    const shots = exportShots(src);
    if (shots.length) {
      out.push(`### ${w.shots}`);
      out.push(shots.map((f) => `![${f.split(/[\\/]/).pop()!.replace(/[[\]]/g, '')}](${shotLink(f)})`).join('\n'));
    }
  }
  const tokens = redactCount(`${out.join('\n\n')}\n`, w.mask);
  const paths = hidePaths(tokens.text, src.home, w.mask);
  return { md: paths.text, hidden: { total: tokens.n + paths.n, tokens: tokens.n, paths: paths.n } };
}

/** The dialog's preview: the heading and the next line, then the lines where something was hidden, up to `n`. */
export function previewLines(md: string, mask: string, n = 4): string[] {
  const lines = md.split('\n').filter((l) => l.trim());
  const pick = new Set<number>(lines.slice(0, 2).map((_l, i) => i));
  for (let i = 0; i < lines.length && pick.size < n; i++) if (lines[i].includes(mask)) pick.add(i);
  for (let i = 0; i < lines.length && pick.size < n; i++) pick.add(i);
  return [...pick].sort((a, b) => a - b).map((i) => (lines[i].length > 200 ? `${lines[i].slice(0, 199)}…` : lines[i]));
}

/** The artifact link in what the publishing session replied, the last one when it named several. */
export function artifactUrl(text: string | null | undefined): string | null {
  const all = text?.match(/https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+/g);
  return all?.length ? all[all.length - 1] : null;
}

/** The file name a save offers: the task's id, or the Worker's. */
export function exportFileName(src: ExportSource): string {
  const x = src.tasks[src.tasks.length - 1];
  return `${(x?.id ?? src.worker.id).replace(/[^\w.-]+/g, '-')}.md`;
}

/** The tools a publishing session has; anything else it asks for is refused. */
export const PUBLISH_TOOLS = ['Read', 'Write', 'Edit', 'Skill', 'ToolSearch', 'Artifact', 'ArtifactComments', 'ArtifactData'];

const ABS = /^(?:[A-Za-z]:[\\/]|[\\/]|~)/;
const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');

/** Whether `file` stays in folder `dir`: relative without "..", or absolute under `dir` (any slash, any case). */
export function insideDir(file: string, dir: string): boolean {
  const f = norm(file.trim());
  if (!f || f.split('/').includes('..')) return false;
  if (!ABS.test(f)) return true;
  const d = norm(dir).toLowerCase();
  return f.toLowerCase() === d || f.toLowerCase().startsWith(`${d}/`);
}

/** Every string inside a tool's input that names a file (an absolute path, or one with ".."). */
function pathsIn(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') { if (ABS.test(v.trim()) || norm(v).split('/').includes('..')) out.push(v); }
  else if (Array.isArray(v)) v.forEach((x) => pathsIn(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => pathsIn(x, out));
  return out;
}

/**
 * Whether the publishing session may run this tool call. The exported text is written by agents and users, so the
 * session only gets its own tools and only files in its own folder: reads, writes and what it publishes alike.
 */
export function publishToolOk(name: string, input: Record<string, unknown>, dir: string): boolean {
  if (!PUBLISH_TOOLS.includes(name)) return false;
  if (name === 'Read' || name === 'Write' || name === 'Edit') return typeof input.file_path === 'string' && insideDir(input.file_path, dir);
  return pathsIn(input).every((f) => insideDir(f, dir));
}

/** The artifact's title: the export's heading (secrets already hidden there), on one line and short. */
export function publishTitle(md: string): string {
  const head = md.split('\n')[0].replace(/^#+\s*/, '').replace(/"/g, '').replace(/\s+/g, ' ').trim();
  return head.length > 120 ? `${head.slice(0, 119)}…` : head;
}
