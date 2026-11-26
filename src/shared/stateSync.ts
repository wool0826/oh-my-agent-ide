// What the main process sends the window when the state changes (decision 216): the whole state when the window
// loads and when it is out of step, otherwise only the parts that changed. Each message is numbered, so the window
// notices one it missed and asks for the whole state again.
import type { AppState } from './types';

export type Part = keyof AppState;

/**
 * How a part was last sent, to compare the next one with: a list of records with an id (or a name) record by record,
 * anything else as its JSON. Equal JSON is the same part: what the window draws cannot tell the two apart.
 */
export type PartPrint = { json: string } | { ids: string[]; recs: Map<string, string> };
export type Prints = Map<Part, PartPrint>;

/** A list part that changed: the records new or changed, the ids gone, and the order when it is not what those give. */
export interface ListChange { put: unknown[]; drop: string[]; order?: string[] }

export interface StateChanges {
  /** Parts sent whole. */
  set: Partial<AppState>;
  /** List parts sent by record. */
  lists: Partial<Record<Part, ListChange>>;
  /** Parts the state no longer has. */
  gone: Part[];
}

export type StateMsg =
  | { kind: 'full'; seq: number; state: AppState }
  | { kind: 'changes'; from: number; seq: number; changes: StateChanges };

type Rec = Record<string, unknown>;

const keyOf = (x: unknown): string | null => {
  if (!x || typeof x !== 'object') return null;
  const r = x as Rec;
  if (typeof r.id === 'string') return r.id;
  return typeof r.name === 'string' ? `name:${r.name}` : null;
};

function printPart(v: unknown): PartPrint {
  if (Array.isArray(v)) {
    const ids: string[] = [];
    const recs = new Map<string, string>();
    for (const x of v) {
      const k = keyOf(x);
      // A list without a key on each record, or with one twice, goes whole.
      if (k === null || recs.has(k)) return { json: JSON.stringify(v) };
      ids.push(k);
      recs.set(k, JSON.stringify(x));
    }
    return { ids, recs };
  }
  return { json: JSON.stringify(v) };
}

/** The prints of every part the state has. */
export function printState(s: AppState): Prints {
  const out: Prints = new Map();
  for (const [p, v] of Object.entries(s)) if (v !== undefined) out.set(p as Part, printPart(v));
  return out;
}

const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

function listChange(was: { ids: string[]; recs: Map<string, string> }, now: { ids: string[]; recs: Map<string, string> }, items: readonly unknown[]): ListChange | null {
  const put: unknown[] = [];
  now.ids.forEach((id, i) => { if (was.recs.get(id) !== now.recs.get(id)) put.push(items[i]); });
  const drop = was.ids.filter((id) => !now.recs.has(id));
  // The order applyChanges makes: the records kept where they were, then the new ones at the end.
  const made = was.ids.filter((id) => now.recs.has(id)).concat(now.ids.filter((id) => !was.recs.has(id)));
  const order = sameIds(made, now.ids) ? undefined : now.ids;
  if (!put.length && !drop.length && !order) return null;
  return order ? { put, drop, order } : { put, drop };
}

/**
 * What changed from the state printed as `was` to `now` (whose prints are `nowPrints`), or null when nothing did.
 * The records sent are those of `now` itself, so the message carries them as they are.
 */
export function stateChanges(was: Prints, now: AppState, nowPrints: Prints = printState(now)): StateChanges | null {
  const set: Rec = {};
  const lists: Partial<Record<Part, ListChange>> = {};
  const gone: Part[] = [];
  let any = false;
  for (const p of was.keys()) if (!nowPrints.has(p)) { gone.push(p); any = true; }
  for (const [p, b] of nowPrints) {
    const a = was.get(p);
    if (a && 'ids' in a && 'ids' in b) {
      const ch = listChange(a, b, now[p] as unknown[]);
      if (ch) { lists[p] = ch; any = true; }
    } else if (!a || !('json' in a) || !('json' in b) || a.json !== b.json) {
      set[p] = now[p];
      any = true;
    }
  }
  return any ? { set: set as Partial<AppState>, lists, gone } : null;
}

/** The changes from `a` to `b`. */
export const diffState = (a: AppState, b: AppState) => stateChanges(printState(a), b);

function applyList(was: unknown, ch: ListChange): unknown[] {
  const prev = Array.isArray(was) ? was : [];
  const drop = new Set(ch.drop);
  const put = new Map(ch.put.map((x) => [keyOf(x), x]));
  const out = prev.filter((x) => !drop.has(keyOf(x)!)).map((x) => {
    const k = keyOf(x);
    const y = put.get(k);
    if (y === undefined) return x;
    put.delete(k);
    return y;
  });
  out.push(...put.values());
  if (!ch.order) return out;
  const byId = new Map(out.map((x) => [keyOf(x)!, x]));
  return ch.order.map((id) => byId.get(id));
}

/**
 * The state after the changes. Parts that did not change are the same objects as before, and so are the records of a
 * list that did not: the window can tell what to draw again by what is new.
 */
export function applyChanges(s: AppState, c: StateChanges): AppState {
  const out: Rec = { ...s };
  for (const p of c.gone) delete out[p];
  for (const [p, v] of Object.entries(c.set)) out[p] = v;
  for (const [p, ch] of Object.entries(c.lists)) out[p] = applyList(out[p], ch as ListChange);
  return out as unknown as AppState;
}

/** The parts the changes touch. */
export const changedParts = (c: StateChanges): Set<Part> => new Set([...Object.keys(c.set), ...Object.keys(c.lists), ...c.gone] as Part[]);

/**
 * The main process's side: numbers each message and remembers what the window holds, to send only what differs
 * from it. `full` is for the window's load and for a window out of step. `next` sends empty changes when nothing
 * changed: a state update after the user did something still draws the window again (decision 140).
 */
export class StateSender {
  private seq = 0;
  private held: Prints | null = null;

  full(state: AppState): StateMsg {
    this.held = printState(state);
    return { kind: 'full', seq: ++this.seq, state };
  }

  next(state: AppState): StateMsg {
    if (!this.held) return this.full(state);
    const prints = printState(state);
    const changes = stateChanges(this.held, state, prints) ?? { set: {}, lists: {}, gone: [] };
    this.held = prints;
    const from = this.seq;
    return { kind: 'changes', from, seq: ++this.seq, changes };
  }
}

export interface Held { seq: number; state: AppState }

/**
 * The window's side. `take`: the state to draw now and the parts that changed (null: all of them). `resync`: a
 * message was missed, ask for the whole state. `skip`: an older message, or changes before the first whole state.
 */
export type Received = { step: 'take'; held: Held; parts: Set<Part> | null } | { step: 'skip' | 'resync' };

export function receive(held: Held | null, msg: StateMsg): Received {
  if (msg.kind === 'full') return !held || msg.seq > held.seq ? { step: 'take', held: { seq: msg.seq, state: msg.state }, parts: null } : { step: 'skip' };
  // The whole state asked for at load is on its way; changes before it have nothing to apply to.
  if (!held || msg.seq <= held.seq) return { step: 'skip' };
  if (msg.from !== held.seq) return { step: 'resync' };
  return { step: 'take', held: { seq: msg.seq, state: applyChanges(held.state, msg.changes) }, parts: changedParts(msg.changes) };
}

/** The panels of the window that draw from the state (app.ts renderAll). */
export type Panel = 'frame' | 'usage' | 'dispatcher' | 'memSync' | 'cancel' | 'chat' | 'chatIns' | 'side' | 'term' | 'workers' | 'repos';

const ALL: readonly Panel[] = ['frame', 'usage', 'dispatcher', 'memSync', 'cancel', 'chat', 'chatIns', 'side', 'term', 'workers', 'repos'];

/**
 * Which panels read each part, with what they call. A panel is drawn again when a part it reads changed; a part
 * read almost everywhere (settings, repos) draws everything. When in doubt a panel is listed: a draw too many costs
 * a little time, one too few leaves the window wrong.
 */
export const PART_PANELS: Record<Part, readonly Panel[]> = {
  ready: ALL,
  setupNeeded: ALL,
  settings: ALL,
  repos: ALL,
  repoAdding: ['repos'],
  preflightFailed: ['frame', 'chat'],
  fake: ['frame'],
  update: ['frame'],
  accounts: ['frame', 'usage', 'chat', 'workers', 'cancel'],
  usageClock: ['frame', 'usage'],
  workers: ['frame', 'chat', 'chatIns', 'workers', 'repos', 'cancel'],
  tasks: ['frame', 'chat', 'chatIns', 'workers', 'repos', 'cancel'],
  openTasks: ['frame'],
  mergeQueue: ['frame', 'chat', 'chatIns', 'workers'],
  decisions: ['frame', 'chat', 'chatIns', 'workers'],
  autoAnswers: ['chat', 'chatIns', 'workers'],
  memorySuggestions: ['chatIns'],
  chat: ['chat'],
  results: ['chatIns'],
  memos: ['chatIns'],
  automations: ['chatIns'],
  scripts: ['chatIns'],
  runs: ['workers'],
  memorySync: ['memSync'],
  dispatcher: ['dispatcher', 'chat'],
};

/** The panels to draw again for these changed parts. */
export function panelsFor(parts: Iterable<Part>): Set<Panel> {
  const out = new Set<Panel>();
  for (const p of parts) for (const x of PART_PANELS[p] ?? ALL) out.add(x);
  return out;
}

/** Something the user did, as `userActed` in ui/core.ts sees it: the event, the id of its target, a key and whether Ctrl, Alt or Meta was held. */
export interface Act { type: string; field: string; key?: string; mods?: boolean }

/** The composers' fields: what is typed in them changes only the composer, which no state update draws. */
const COMPOSERS = new Set(['chat-input', 'ws-input']);

/**
 * Whether the next state update draws every panel (decision 140: handlers change the page by hand and count on the
 * draw to put it right). Text typed into a composer, Enter included, does not: its handlers change only the
 * composer, and a typed chat message then draws only what it changed. A key with Ctrl, Alt or Meta, Tab and
 * Escape still count, since the shortcuts and dialogs they reach are anywhere.
 */
export function countsAsAct(a: Act): boolean {
  if (!COMPOSERS.has(a.field)) return true;
  if (a.type === 'input') return false;
  if (a.type !== 'keydown') return true;
  return !!a.mods || a.key === 'Tab' || a.key === 'Escape';
}
