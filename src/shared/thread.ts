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

// Threads as a panel (T-0076, design C of T-0074): a report or a Dispatcher message is the root; the chat shows the
// root with its last reply and the count, and the whole thread opens in a panel. `replyTo` names the root by its chat
// message id, or, as before, by a task id: the report card of that task most recently above the reply.

export interface RootItem { id: string; kind: string; ref?: string; replyTo?: string }

/** A message a thread can grow from: a report card, or a Dispatcher message. */
export function canRoot(c: RootItem): boolean {
  return isReport(c) || c.kind === 'dispatcher';
}

/** Where each item goes: `rootOf[i]` is the index of its thread's root, or -1 for an item drawn in the chat itself. */
export interface ThreadIndex { rootOf: number[]; replies: Map<number, number[]> }

/**
 * The threads among `items`. A reply to a reply joins the same thread; a reply whose root is not among `items` (not
 * loaded, or gone), or names a message that cannot be a root, is drawn in the chat as a plain message.
 */
export function threadIndex(items: RootItem[]): ThreadIndex {
  const byId = new Map<string, number>();
  const lastReport = new Map<string, number>();
  const rootOf: number[] = [];
  const replies = new Map<number, number[]>();
  items.forEach((c, i) => {
    let at = c.replyTo ? byId.get(c.replyTo) ?? lastReport.get(c.replyTo) : undefined;
    if (at !== undefined && rootOf[at] >= 0) at = rootOf[at];
    const root = at !== undefined && canRoot(items[at]) ? at : -1;
    rootOf.push(root);
    if (root >= 0) {
      const list = replies.get(root);
      if (list) list.push(i); else replies.set(root, [i]);
    } else if (isReport(c)) lastReport.set(c.ref!, i);
    byId.set(c.id, i);
  });
  return { rootOf, replies };
}

/**
 * Threads whose newest reply came after other messages in the chat: the root is out of the way by then, so the chat
 * says so where that reply is (the index of the reply → its root).
 */
export function lateReplies(index: ThreadIndex): Map<number, number> {
  const out = new Map<number, number>();
  for (const [root, list] of index.replies) {
    const last = list[list.length - 1];
    for (let i = root + 1; i < last; i++) if (index.rootOf[i] < 0) { out.set(last, root); break; }
  }
  return out;
}

/**
 * What a reply is filed under when it is sent: the root of the message it names (that message, or the root of the
 * thread it is in), by its chat id; a report that is its task's newest card is named by the task, as saved replies are.
 * A task id is that task's newest report. Null when it names nothing in `chat` that a thread can grow from.
 */
export function threadTarget(chat: RootItem[], to: string | null | undefined): string | null {
  if (!to) return null;
  const newest = (ref: string) => {
    for (let i = chat.length - 1; i >= 0; i--) if (isReport(chat[i]) && chat[i].ref === ref) return i;
    return -1;
  };
  const at = chat.findIndex((c) => c.id === to);
  if (at < 0) return newest(to) >= 0 ? to : null;
  const ix = threadIndex(chat);
  const root = ix.rootOf[at] >= 0 ? ix.rootOf[at] : at;
  const c = chat[root];
  if (!canRoot(c)) return null;
  return isReport(c) && newest(c.ref!) === root ? c.ref! : c.id;
}
