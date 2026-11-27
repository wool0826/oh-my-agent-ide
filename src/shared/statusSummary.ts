// Status rows in Settings, summarised (T-0157, decision 246): one line per row with its state and a short value,
// the long values (paths, errors, commands, lists) behind a disclosure. Any group of such rows can use these.

export type StatusTone = 'ok' | 'warn' | 'bad';

/** How a long value is cut down to its short form. */
export type ValueKind = 'text' | 'version' | 'path' | 'error' | 'list';

/** One line of a row's detail: a label and the whole value, with a copy button when `copy`. */
export interface StatusField { label: string; value: string; copy?: boolean }

export interface StatusItem {
  /** Unique within its group; it keeps the row open across redraws. */
  id: string;
  name: string;
  tone: StatusTone;
  /** What the row shows after its name. */
  short: string;
  fields: StatusField[];
}

export const SHORT_MAX = 40;

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, Math.max(1, max - 1)).trimEnd()}…`);

/** The end of a path that fits in `max`: `…/parent/name`, or `…/name` cut down when even that is too long. */
function briefPath(p: string, max: number): string {
  if (p.length <= max) return p;
  const sep = p.includes('/') ? '/' : '\\';
  const parts = p.split(/[\\/]+/).filter(Boolean);
  for (let keep = parts.length - 1; keep >= 1; keep--) {
    const tail = `…${sep}${parts.slice(-keep).join(sep)}`;
    if (tail.length <= max) return tail;
  }
  return clip(`…${sep}${parts[parts.length - 1] ?? ''}`, max);
}

/** The words of an error that say what went wrong, without the payload, the stack or the file it names. */
function briefError(e: string, max: number): string {
  let s = (e.trim().split('\n')[0] ?? '').trim().replace(/^(Uncaught )?(\w*Error: )+/, '');
  // Node's file errors: "EACCES: permission denied, open '/a/b'" -> "EACCES: permission denied".
  const fsErr = /^([A-Z][A-Z0-9_]+): ([^,]+), \w+ ['"]/.exec(s);
  if (fsErr) s = `${fsErr[1]}: ${fsErr[2]}`;
  // A JSON body, or what follows a dash, is detail.
  s = s.split(/\s*[{[]|\s+[—–]\s+/)[0] ?? s;
  // The first sentence.
  s = s.split(/(?<=[^.\s]{2})\.\s/)[0] ?? s;
  s = s.replace(/[\s:;,.\-–—]+$/, '');
  return clip(s || oneLine(e), max);
}

/**
 * The short form of a long value for a status row. `full` is the value as given, with nothing taken out;
 * `cut` says whether `short` leaves something out, so the row needs its detail to show all of it.
 */
export function brief(value: string | readonly string[], kind: ValueKind = 'text', max = SHORT_MAX): { short: string; full: string; cut: boolean } {
  if (kind === 'list' || typeof value !== 'string') {
    const items = (typeof value === 'string' ? value.split(/[,\n]/) : [...value]).map(oneLine).filter(Boolean);
    const full = items.join(', ');
    if (!items.length) return { short: '', full, cut: false };
    const more = items.length > 1 ? ` +${items.length - 1}` : '';
    const short = `${clip(items[0]!, Math.max(4, max - more.length))}${more}`;
    return { short, full, cut: short !== full };
  }
  const full = value.trim();
  let short: string;
  if (kind === 'version') short = /\d+(\.\d+)+([-+][\w.]+)?/.exec(full)?.[0] ?? clip(oneLine(full), max);
  else if (kind === 'path') short = briefPath(full, max);
  else if (kind === 'error') short = briefError(full, max);
  else short = clip(oneLine(full), max);
  return { short, full, cut: short !== full };
}

/** Rows that need something first (bad, then warnings), the fine ones after, each kept in the order given. */
export function ordered(items: readonly StatusItem[]): StatusItem[] {
  const rank: Record<StatusTone, number> = { bad: 0, warn: 1, ok: 2 };
  return items.map((x, i) => ({ x, i })).sort((a, b) => rank[a.x.tone] - rank[b.x.tone] || a.i - b.i).map((a) => a.x);
}

/** A row's name for the summary line: the part before a colon ("GitHub sign-in: host" -> "GitHub sign-in"). */
export const tagOf = (name: string) => name.split(':')[0]!.trim() || name;

export interface StatusTally {
  /** The names on the summary line of the rows that need something, each once, at most `max` of them. */
  tags: { tag: string; tone: StatusTone }[];
  /** How many more names there were. */
  more: number;
  ok: number;
  total: number;
}

/** What the summary line of a group shows: the rows that need something by name, and how many are fine. */
export function tally(items: readonly StatusItem[], max = 3): StatusTally {
  const seen = new Map<string, StatusTone>();
  for (const x of ordered(items)) if (x.tone !== 'ok' && !seen.has(tagOf(x.name))) seen.set(tagOf(x.name), x.tone);
  const all = [...seen].map(([tag, tone]) => ({ tag, tone }));
  return { tags: all.slice(0, max), more: Math.max(0, all.length - max), ok: items.filter((x) => x.tone === 'ok').length, total: items.length };
}
