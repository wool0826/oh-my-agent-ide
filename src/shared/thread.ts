// Replies under a Worker's report in the chat (T-0053 item 1): a result or failure card is the root, and the
// messages that answer it (the Dispatcher's explanation, the user's questions about it, the answers) sit one step
// in under it. Never deeper: a reply to a reply stays at the same step.

export interface ThreadItem { kind: string; ref?: string; replyTo?: string }

export interface ThreadSlot {
  /** 1: drawn one step in, under its report. */
  depth: 0 | 1;
  /** The first reply of a group: the group opens here. */
  start: boolean;
  /** The report is further up, with other messages between: the group names it with a chip that goes to it. */
  late: boolean;
  /** The task whose report this answers (depth 1 only). */
  root?: string;
}

/** A report card: a task's result, or its failure. */
export function isReport(c: ThreadItem): boolean {
  return (c.kind === 'result' || c.kind === 'error') && !!c.ref;
}

/**
 * Where each chat item goes. A reply right after its report, or after earlier replies to it, joins the report's
 * group; a reply that comes later keeps its place in time as a late group of its own. A reply whose report is not
 * among `items` (not loaded, or gone) is drawn as today.
 */
export function threadLayout(items: ThreadItem[]): ThreadSlot[] {
  const seen = new Set<string>();
  let open: string | null = null;
  return items.map((c): ThreadSlot => {
    if (isReport(c)) {
      seen.add(c.ref!);
      open = c.ref!;
      return { depth: 0, start: false, late: false };
    }
    const to = c.replyTo;
    if (to && to === open) {
      // `open` stays: the next reply to it joins the same group.
      return { depth: 1, start: false, late: false, root: to };
    }
    if (to && seen.has(to)) {
      open = to;
      return { depth: 1, start: true, late: true, root: to };
    }
    open = null;
    return { depth: 0, start: false, late: false };
  }).map((s, i, all): ThreadSlot => (s.depth === 1 && !s.late && all[i - 1]?.depth === 0 ? { ...s, start: true } : s));
}

/**
 * The task a Dispatcher turn answers: the one report that started it. Several reports at once, or none, answer
 * nothing in particular, so the turn's messages stay top level.
 */
export function turnReplyTo(reports: string[]): string | null {
  const ids = [...new Set(reports)];
  return ids.length === 1 ? ids[0] : null;
}

/** A reply thread as one card (T-0072): the replies to one report in a row. `key` is its first reply's id. */
export interface ReplyThread { root: string; late: boolean; rows: number[]; key: string }

/** The reply threads of a laid-out chat (threadLayout), by the index of their first reply. */
export function replyThreads(items: { id: string }[], slots: ThreadSlot[]): Map<number, ReplyThread> {
  const out = new Map<number, ReplyThread>();
  let g: ReplyThread | null = null;
  slots.forEach((slot, i) => {
    if (slot.depth !== 1) { g = null; return; }
    if (slot.start || !g) out.set(i, (g = { root: slot.root!, late: slot.late, rows: [], key: items[i].id }));
    g.rows.push(i);
  });
  return out;
}

/**
 * Whether a thread is open: as the user left it, else open for the newest thread only, so older talk folds to its
 * heading as the chat moves on. `set`: the threads the user opened (true) or folded (false), by key.
 */
export function threadOpen(key: string, newest: string | undefined, set: ReadonlyMap<string, boolean>): boolean {
  return set.get(key) ?? key === newest;
}
