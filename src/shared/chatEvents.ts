// Chat events as one-line rows, and a burst of them folded into one summary row (T-0140, option C; decision 234).
// Main tags each event line with its parts (ChatItem.ev): what happened, to which task and Worker, and the numbers its
// badge shows. The thread draws every event as a row (icon, task id, short title, Worker, badge, time); events that come
// close together fold into one row that counts them by kind. What needs the user stays outside the fold.

/** What an event line says happened. */
export type EvKind =
  // a task
  | 'started' | 'startFailed' | 'depClosed' | 'depEnded' | 'cancelled' | 'dropped' | 'followers' | 'queueCleared' | 'kept'
  | 'failed' | 'planMissing' | 'picked' | 'stalled'
  // its PR
  | 'merged' | 'closed' | 'review' | 'ci' | 'conflict' | 'queueLeft'
  // messages
  | 'asked' | 'answered' | 'request' | 'blocked' | 'corrected' | 'correctFailed' | 'memory' | 'comment' | 'replied'
  // the Dispatcher
  | 'limitPaused' | 'limitHeld' | 'accountsOff' | 'resumed' | 'dStopped' | 'dError' | 'noAccount' | 'autoPaused' | 'newChat' | 'cleared'
  | 'compacted' | 'compactFailed'
  // repositories and the saved state
  | 'cloning' | 'registered' | 'setupFailed' | 'state';

/** An event line's parts (ChatItem.ev). Lines saved before these were kept have none and show their sentence. */
export interface ChatEv {
  k: EvKind;
  /** The task it is about (T-xxxx). */
  task?: string;
  /** The Worker it is about (W-xx). */
  worker?: string;
  /** What the row names when the task alone does not: a task's title, a message, a repository. */
  title?: string;
  /** The task this one waited on: a start after a merge hangs under the merge (cause and effect). */
  dep?: string;
  n?: number;
  max?: number;
  /** A number of the PR. */
  pr?: number;
  /** A value the badge shows as it is: a time, a size ("84k → 12k"). */
  note?: string;
  /** Kind-specific variant of the badge: kept changes, a local repository, a comment left without a reply. */
  alt?: boolean;
}

/** The icons of event rows: each a symbol in the window's sprite (index.html, `e-*`). */
export type EvIcon = 'merged' | 'closed' | 'started' | 'queued' | 'ci' | 'bubble' | 'clock' | 'failed' | 'cancel' | 'stop'
  | 'alert' | 'branch' | 'check' | 'question' | 'memory' | 'refresh' | 'compact' | 'repo' | 'pause';

/** A pill's tone, as the stylesheet names it ('' is the neutral pill). */
export type EvTone = 'accent' | 'review' | 'warning' | 'success' | 'danger' | '';

interface KindInfo { icon: EvIcon; tone: EvTone; attention?: boolean }

/** How each kind looks; `attention`: it needs the user, so it never folds away. */
export const EV_KINDS: Record<EvKind, KindInfo> = {
  started: { icon: 'started', tone: 'accent' },
  startFailed: { icon: 'alert', tone: 'danger', attention: true },
  depClosed: { icon: 'cancel', tone: 'danger', attention: true },
  depEnded: { icon: 'cancel', tone: '' },
  cancelled: { icon: 'cancel', tone: '' },
  dropped: { icon: 'cancel', tone: '' },
  followers: { icon: 'cancel', tone: '' },
  queueCleared: { icon: 'cancel', tone: '' },
  kept: { icon: 'branch', tone: 'warning' },
  failed: { icon: 'failed', tone: 'danger', attention: true },
  planMissing: { icon: 'alert', tone: 'warning', attention: true },
  picked: { icon: 'check', tone: 'success' },
  stalled: { icon: 'clock', tone: 'warning' },
  merged: { icon: 'merged', tone: 'review' },
  closed: { icon: 'closed', tone: '' },
  review: { icon: 'bubble', tone: 'review' },
  ci: { icon: 'ci', tone: 'warning' },
  conflict: { icon: 'alert', tone: 'warning' },
  queueLeft: { icon: 'queued', tone: '' },
  asked: { icon: 'question', tone: 'accent' },
  answered: { icon: 'bubble', tone: '' },
  request: { icon: 'bubble', tone: 'accent' },
  blocked: { icon: 'alert', tone: 'warning' },
  corrected: { icon: 'refresh', tone: '' },
  correctFailed: { icon: 'alert', tone: 'danger', attention: true },
  memory: { icon: 'memory', tone: '' },
  comment: { icon: 'bubble', tone: 'accent' },
  replied: { icon: 'check', tone: '' },
  limitPaused: { icon: 'queued', tone: 'warning', attention: true },
  limitHeld: { icon: 'queued', tone: 'warning', attention: true },
  accountsOff: { icon: 'pause', tone: 'warning', attention: true },
  resumed: { icon: 'started', tone: 'success' },
  dStopped: { icon: 'stop', tone: '' },
  dError: { icon: 'alert', tone: 'danger', attention: true },
  noAccount: { icon: 'alert', tone: 'danger', attention: true },
  autoPaused: { icon: 'pause', tone: 'warning', attention: true },
  newChat: { icon: 'refresh', tone: '' },
  cleared: { icon: 'refresh', tone: '' },
  compacted: { icon: 'compact', tone: '' },
  compactFailed: { icon: 'alert', tone: 'danger', attention: true },
  cloning: { icon: 'repo', tone: '' },
  registered: { icon: 'repo', tone: 'success' },
  setupFailed: { icon: 'alert', tone: 'danger', attention: true },
  state: { icon: 'alert', tone: 'danger', attention: true },
};

/** The colour of an icon by its tone, as a `c-*` class of the stylesheet. */
export const TONE_COLOR: Record<EvTone, string> = { accent: 'c-blue', review: 'c-purple', warning: 'c-orange', success: 'c-green', danger: 'c-red', '': 'c-gray' };

/** The badge of a row: an i18n key (`evb.*`) and its values. */
export function evBadge(e: ChatEv): { key: string; vars: Record<string, string | number> } {
  const v = { n: e.n ?? 0, max: e.max ?? 0, pr: e.pr ?? 0, note: e.note ?? '' };
  const key = (() => {
    switch (e.k) {
      case 'merged': return e.pr ? 'evb.mergedPr' : 'evb.merged';
      case 'closed': return e.pr ? 'evb.closedPr' : 'evb.closed';
      case 'failed': return e.max ? 'evb.failedAt' : 'evb.failed';
      case 'kept': return e.alt ? 'evb.uncommitted' : 'evb.commits';
      case 'registered': return e.alt ? 'evb.local' : 'evb.registered';
      case 'replied': return e.alt ? 'evb.noReply' : 'evb.replied';
      case 'ci': return e.max ? 'evb.ci' : 'evb.ciFix';
      case 'limitPaused': case 'limitHeld': return e.note ? 'evb.until' : 'evb.limit';
      case 'accountsOff': return e.note ? 'evb.until' : 'evb.accountsOff';
      case 'stalled': return 'evb.idle';
      case 'compacted': return e.note ? 'evb.note' : 'evb.compacted';
      default: return `evb.${e.k}`;
    }
  })();
  return { key, vars: v };
}

/** The badge keys `evBadge` can give, so a test can check each has its words. */
export const EV_BADGE_KEYS = [
  'evb.mergedPr', 'evb.merged', 'evb.closedPr', 'evb.closed', 'evb.failedAt', 'evb.failed', 'evb.uncommitted', 'evb.commits',
  'evb.local', 'evb.registered', 'evb.noReply', 'evb.replied', 'evb.ci', 'evb.ciFix', 'evb.until', 'evb.limit', 'evb.idle',
  'evb.note', 'evb.compacted',
  ...(Object.keys(EV_KINDS) as EvKind[]).filter((k) => !['merged', 'closed', 'failed', 'kept', 'registered', 'replied', 'ci', 'limitPaused', 'limitHeld', 'stalled', 'compacted'].includes(k)).map((k) => `evb.${k}`),
];

export interface EvItem { id: string; ts: string; kind: string; sub?: string; ev?: ChatEv }

/** A line the thread draws as an event row: an event (not a hand-out, which has its own block) or an error. */
export const isEventLine = (c: EvItem): boolean => (c.kind === 'event' && c.sub !== 'handout') || c.kind === 'error';

/** It needs the user: an error, or a kind that waits for them (a usage limit, a failure, a missing plan). */
export const needsUser = (c: EvItem): boolean => c.kind === 'error' || !!(c.ev && EV_KINDS[c.ev.k].attention);

/** A row and the events it caused right after, drawn under it (a merge, then the task that waited on it starting). */
export interface EvRow<T> { c: T; then: T[] }

/** How many events of one icon a fold holds; `kinds` names them for the tooltip. */
export interface EvCount { icon: EvIcon; tone: EvTone; kinds: EvKind[]; n: number }

/**
 * A run of event lines next to each other in the thread within one window of time.
 * `fold`: enough of them to fold into one summary row; then `pinned`, what needs the user, is drawn under the fold
 * instead of inside it. Unfolded, every line is a row in time order and `pinned` is empty.
 */
export interface EvBlock<T> { id: string; fold: boolean; rows: EvRow<T>[]; pinned: T[]; counts: EvCount[]; n: number; from: string; to: string }

/** A burst: at least 3 events that do not need the user, within 60 s of the first one (option C). */
export const BURST_MIN = 3;
export const BURST_MS = 60_000;

/** Hang each event that names a task it waited on under the merge or close of that task earlier in the run. */
function pairRows<T extends EvItem>(lines: T[]): EvRow<T>[] {
  const rows: EvRow<T>[] = [];
  for (const c of lines) {
    const dep = c.ev?.dep;
    const cause = dep ? [...rows].reverse().find((r) => r.c.ev?.task === dep && (r.c.ev.k === 'merged' || r.c.ev.k === 'closed')) : undefined;
    if (cause) cause.then.push(c);
    else rows.push({ c, then: [] });
  }
  return rows;
}

/** Fold counts by icon, in the order each first shows up. */
function countRows<T extends EvItem>(lines: T[]): EvCount[] {
  const out: EvCount[] = [];
  for (const c of lines) {
    const k = c.ev?.k;
    const info = k ? EV_KINDS[k] : null;
    const icon: EvIcon = info?.icon ?? 'refresh';
    const hit = out.find((x) => x.icon === icon);
    if (hit) { hit.n++; if (k && !hit.kinds.includes(k)) hit.kinds.push(k); } else out.push({ icon, tone: info?.tone ?? '', kinds: k ? [k] : [], n: 1 });
  }
  return out;
}

/**
 * The event blocks of a thread, by the id of their first line. Lines next to each other (nothing else between them)
 * share a block while they are within `windowMs` of its first line; a later one starts the next block. The thread
 * draws a block where its first line is and skips the others (`eventFolded`).
 */
export function eventBlocks<T extends EvItem>(items: T[], windowMs = BURST_MS, min = BURST_MIN): Map<string, EvBlock<T>> {
  const blocks = new Map<string, EvBlock<T>>();
  let run: T[] = [];
  const close = () => {
    if (!run.length) return;
    const calm = run.filter((c) => !needsUser(c));
    const fold = calm.length >= min;
    blocks.set(run[0].id, {
      id: run[0].id, fold,
      rows: pairRows(fold ? calm : run),
      pinned: fold ? run.filter(needsUser) : [],
      counts: fold ? countRows(calm) : [],
      n: fold ? calm.length : run.length,
      from: run[0].ts, to: run[run.length - 1].ts,
    });
    run = [];
  };
  for (const c of items) {
    if (!isEventLine(c)) { close(); continue; }
    if (run.length && Date.parse(c.ts) - Date.parse(run[0].ts) > windowMs) close();
    run.push(c);
  }
  close();
  return blocks;
}

/** The ids of the lines drawn inside a block other than their own. */
export function eventFolded(blocks: Map<string, EvBlock<EvItem>>): Set<string> {
  const out = new Set<string>();
  for (const b of blocks.values()) {
    for (const r of b.rows) { out.add(r.c.id); for (const x of r.then) out.add(x.id); }
    for (const p of b.pinned) out.add(p.id);
    out.delete(b.id);
  }
  return out;
}

/** The number of a GitHub PR from its URL. */
export const prNumber = (url: string | null | undefined): number | undefined => Number(url?.match(/\/pull\/(\d+)/)?.[1]) || undefined;

/** The parts of an event about a task: the task, its Worker and its title. */
export const evAbout = (x: { id: string; workerId?: string | null; title: string }) => ({ task: x.id, worker: x.workerId ?? undefined, title: x.title });
