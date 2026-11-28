// How the Changes tab shows a diff (item 10A): one column or side by side, which files were seen, which are too big to
// draw until asked, and the rows each layout draws. The window only turns these into HTML (ui/workers.ts).
import type { DiffFile } from './types';

export type DiffLayout = 'unified' | 'split';

/** Side by side needs this much width in the pane; below it the tab stays in one column and the switch is off. */
export const SPLIT_MIN = 900;

export function diffLayout(pref: DiffLayout, width: number): { layout: DiffLayout; canSplit: boolean } {
  const canSplit = width >= SPLIT_MIN;
  return { layout: canSplit ? pref : 'unified', canSplit };
}

export interface DiffLine {
  kind: 'h' | 'add' | 'del' | 'ctx';
  /** The line without its +, - or space (a hunk header as it is). */
  text: string;
  /** Its index in the patch's lines, which places a comment (shared/diffComment.ts counts the same way). */
  i: number;
  old: number | null;
  new: number | null;
}

/** A patch's lines with the old and the new line number of each. */
export function numberedLines(patch: string): DiffLine[] {
  let o = 0, n = 0;
  return patch.replace(/\n+$/, '').split('\n').map((raw, i): DiffLine => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) { o = Number(hunk[1]); n = Number(hunk[2]); return { kind: 'h', text: raw, i, old: null, new: null }; }
    if (raw.startsWith('\\') || raw.startsWith('@@')) return { kind: 'h', text: raw, i, old: null, new: null };
    if (raw.startsWith('+')) return { kind: 'add', text: raw.slice(1), i, old: null, new: n++ };
    if (raw.startsWith('-')) return { kind: 'del', text: raw.slice(1), i, old: o++, new: null };
    return { kind: 'ctx', text: raw.slice(1), i, old: o++, new: n++ };
  });
}

/** One row side by side: a hunk header across both, or the old line on the left and the new one on the right. */
export type SplitRow = { h: DiffLine } | { left: DiffLine | null; right: DiffLine | null };

/** Removed lines face the lines added in their place; the shorter side is padded with empty cells. */
export function splitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let dels: DiffLine[] = [], adds: DiffLine[] = [];
  const flush = () => {
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
    dels = []; adds = [];
  };
  for (const l of lines) {
    if (l.kind === 'del') { if (adds.length) flush(); dels.push(l); continue; }
    if (l.kind === 'add') { adds.push(l); continue; }
    flush();
    rows.push(l.kind === 'h' ? { h: l } : { left: l, right: l });
  }
  flush();
  return rows;
}

/** A file is "seen" for its content: a new change to it makes it unseen again. */
export function seenKey(f: Pick<DiffFile, 'path' | 'patch'>): string {
  let h = 5381;
  for (let i = 0; i < f.patch.length; i++) h = ((h << 5) + h + f.patch.charCodeAt(i)) | 0;
  return `${f.path}:${f.patch.length}:${(h >>> 0).toString(36)}`;
}

export function seenCount(files: Pick<DiffFile, 'path' | 'patch'>[], seen: ReadonlySet<string>): number {
  return files.filter((f) => seen.has(seenKey(f))).length;
}

/** Lines of a patch drawn without asking; a longer one, or a lockfile, waits for its expand button. */
export const BIG_LINES = 1500;
const LOCKS = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|Gemfile\.lock|composer\.lock|go\.sum)$/;

export function bigFile(f: Pick<DiffFile, 'path' | 'patch'>): boolean {
  if (!f.patch) return false;
  if (LOCKS.test(f.path)) return true;
  let n = 0;
  for (let i = f.patch.indexOf('\n'); i >= 0 && n <= BIG_LINES; i = f.patch.indexOf('\n', i + 1)) n++;
  return n > BIG_LINES;
}

/** "2.1 MB", "340 KB", "12 B". */
export function sizeText(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** The file J (1) or K (-1) moves to from `at` (-1 when none has the focus yet), staying within the list. */
export function stepFile(at: number, n: number, dir: 1 | -1): number {
  if (!n) return -1;
  if (at < 0) return dir > 0 ? 0 : n - 1;
  return Math.min(n - 1, Math.max(0, at + dir));
}
