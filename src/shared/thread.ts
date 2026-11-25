// Reply threads in the chat: a report or a Dispatcher message is the root of a thread (T-0076). Its replies hang off it
// on branches (A-1 of T-0086): one step in under the root, every message still in the chat in its place in time.

/** A report card: a task's result, or its failure. */
export function isReport(c: { kind: string; ref?: string }): boolean {
  return (c.kind === 'result' || c.kind === 'error') && !!c.ref;
}

/**
 * The task a Dispatcher turn answers: the one report that started it. Several reports at once, or none, answer
 * nothing in particular, so the turn's messages stay top level.
 */
export function turnReplyTo(reports: string[]): string | null {
  const ids = [...new Set(reports)];
  return ids.length === 1 ? ids[0] : null;
}

// `replyTo` names the root by its chat message id, or, as saved replies and the Dispatcher's automatic turns do, by a
// task id: the report card of that task most recently above the reply.

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

/** Where a reply is drawn: on the branch of `root`; `start` opens a branch, `late` one that starts from a tag. */
export interface BranchRow { root: number; start: boolean; late: boolean }

/**
 * The branches of the chat, by item: null for a message drawn in the chat itself. A run of replies to one root is one
 * branch; it hangs right under the root when the root is the message above it, and otherwise (other messages, or
 * another thread's replies, came between) it starts from a tag that names the root.
 */
export function branchLayout(index: ThreadIndex): (BranchRow | null)[] {
  const out: (BranchRow | null)[] = [];
  index.rootOf.forEach((root, i) => {
    if (root < 0) { out.push(null); return; }
    const prev = out[i - 1];
    if (prev && prev.root === root) { out.push({ root, start: false, late: prev.late }); return; }
    out.push({ root, start: true, late: i - 1 !== root });
  });
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
