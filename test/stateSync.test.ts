import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { applyChanges, changedParts, diffState, panelsFor, PART_PANELS, receive, StateSender, type Held, type Part, type StateMsg } from '../src/shared/stateSync';
import type { AppState, ChatItem } from '../src/shared/types';

// States a run of the app with fake agents went through (tasks, a failure, a decision, a memo, a script, cleared results).
const recorded: AppState[] = JSON.parse(fs.readFileSync(path.join('test', 'fixtures', 'sync', 'recorded.json'), 'utf8'));
const last = recorded[recorded.length - 1];

/** What a value is once sent: equal JSON (a missing field and an undefined one are the same to the window). */
const sent = (x: unknown) => JSON.parse(JSON.stringify(x));
const same = (a: AppState, b: AppState) => assert.deepStrictEqual(sent(a), sent(b));
/** What the window gets: the IPC copies the message. */
const ipc = <T>(x: T): T => structuredClone(x);

function roundTrip(a: AppState, b: AppState) {
  const ch = diffState(a, b);
  const out = ch ? applyChanges(a, ipc(ch)) : a;
  same(out, b);
  if (!ch) return out;
  // What did not change is still the very same object: a part, or a record of a list.
  const parts = changedParts(ch);
  for (const p of Object.keys(a) as Part[]) if (!parts.has(p)) assert.equal(out[p], a[p], `${p} kept`);
  for (const [p, lc] of Object.entries(ch.lists)) {
    const put = new Set(lc!.put.map((x) => (x as { id?: string }).id));
    const was = new Map((a[p as Part] as { id: string }[]).map((x) => [x.id, x]));
    for (const r of out[p as Part] as { id: string }[]) if (!put.has(r.id) && was.has(r.id)) assert.equal(r, was.get(r.id), `${p} ${r.id} kept`);
  }
  return out;
}

/** A small seeded random source, so a failure can be run again. */
function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 2 ** 32; };
}

/** The state after a few random edits: records added, removed, changed and moved; other parts changed or dropped. */
function edit(s: AppState, r: () => number, n: number): AppState {
  const out = sent(s) as Record<string, unknown>;
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  for (let i = 0; i < n; i++) {
    const p = pick(Object.keys(out));
    const v = out[p];
    if (Array.isArray(v)) {
      const op = pick(['add', 'add', 'remove', 'change', 'change', 'move', 'empty', 'keyless']);
      if (op === 'add') v.splice(Math.floor(r() * (v.length + 1)), 0, { id: `new-${i}-${Math.floor(r() * 1e9)}`, text: 'added' });
      else if (op === 'remove' && v.length) v.splice(Math.floor(r() * v.length), 1);
      else if (op === 'change' && v.length) { const x = v[Math.floor(r() * v.length)]; if (x && typeof x === 'object') (x as Record<string, unknown>).edited = r(); }
      else if (op === 'move' && v.length > 1) { const [x] = v.splice(Math.floor(r() * v.length), 1); v.splice(Math.floor(r() * v.length), 0, x); }
      else if (op === 'empty') v.length = 0;
      else if (op === 'keyless') v.push(pick([1, 'two', { no: 'id' }]));
    } else if (v && typeof v === 'object') (v as Record<string, unknown>)[pick(['a', 'b', 'busy'])] = r();
    else if (typeof v === 'boolean') out[p] = !v;
    else if (typeof v === 'number') out[p] = v + 1;
    else if (r() < 0.3) delete out[p];
    else out[p] = `${v}x`;
  }
  return out as unknown as AppState;
}

test('stateSync: the changes between any two recorded states give back the later one', () => {
  for (const a of recorded) for (const b of recorded) roundTrip(a, b);
  assert.equal(diffState(last, sent(last)), null, 'nothing changed: nothing to send');
});

test('stateSync: random edits of the recorded states round-trip, and what did not change stays the same object', () => {
  const r = rng(115);
  for (const s of recorded) {
    let a = s;
    for (let i = 0; i < 150; i++) {
      const b = edit(a, r, 1 + Math.floor(r() * 4));
      roundTrip(a, b);
      a = b;
    }
  }
});

test('stateSync: a chat message is sent as that one record, and only the chat is drawn again', () => {
  const msg: ChatItem = { id: 'c-new', ts: '2026-11-26T10:00:00.000Z', kind: 'user', text: 'One more thing' };
  const b = { ...last, chat: [...last.chat, msg] };
  const ch = diffState(last, b)!;
  assert.deepEqual(ch, { set: {}, lists: { chat: { put: [msg], drop: [] } }, gone: [] });
  assert.deepEqual([...panelsFor(changedParts(ch))], ['chat']);
  // The window holds the last 400: the oldest goes as the new one comes, without an order to send.
  const slid = { ...last, chat: [...last.chat.slice(1), msg] };
  assert.deepEqual(diffState(last, slid)!.lists.chat, { put: [msg], drop: [last.chat[0].id] });
});

test('stateSync: a list in a new order sends the order; a list without ids, and anything else, goes whole', () => {
  const b = { ...last, tasks: [...last.tasks].reverse() };
  assert.deepEqual(diffState(last, b)!.lists.tasks, { put: [], drop: [], order: b.tasks.map((x) => x.id) });
  const q = { ...last, mergeQueue: [{ taskId: 'T-0001', prUrl: 'https://github.com/o/app/pull/1', phase: 'waiting', since: '2026-11-26T10:00:00.000Z' }] } as unknown as AppState;
  assert.deepEqual(Object.keys(diffState(last, q)!.set), ['mergeQueue']);
  const d = { ...last, dispatcher: { ...last.dispatcher, busy: true } };
  assert.deepEqual(diffState(last, d), { set: { dispatcher: d.dispatcher }, lists: {}, gone: [] });
  assert.deepEqual([...panelsFor(['dispatcher'])].sort(), ['chat', 'dispatcher']);
});

test('stateSync: the sender numbers its messages, and sends empty changes when nothing changed', () => {
  const tx = new StateSender();
  const a = recorded[1];
  const b = recorded[2];
  assert.deepEqual(tx.next(a), { kind: 'full', seq: 1, state: a });
  // Still a message: after the user did something, the window draws every panel at the next one (decision 140).
  assert.deepEqual(tx.next(sent(a)), { kind: 'changes', from: 1, seq: 2, changes: { set: {}, lists: {}, gone: [] } });
  const m = tx.next(b);
  assert.equal(m.kind === 'changes' && `${m.from}>${m.seq}`, '2>3');
  // A whole state starts again from itself.
  assert.deepEqual(tx.full(a), { kind: 'full', seq: 4, state: a });
  const m2 = tx.next(b);
  assert.equal(m2.kind === 'changes' && `${m2.from}>${m2.seq}`, '4>5');
});

test('stateSync: the window takes messages in order, skips old ones, and asks again after a gap', () => {
  const [a, b, c] = recorded.slice(1, 4);
  const full = (seq: number, state: AppState): StateMsg => ({ kind: 'full', seq, state });
  const changes = (from: number, seq: number, x: AppState, y: AppState): StateMsg => ({ kind: 'changes', from, seq, changes: diffState(x, y)! });
  // Changes before the first whole state have nothing to apply to: the whole state asked for at load is coming.
  assert.equal(receive(null, changes(1, 2, a, b)).step, 'skip');
  const r1 = receive(null, full(2, a));
  assert.equal(r1.step, 'take');
  const held = (r1 as { held: Held }).held;
  const r2 = receive(held, changes(2, 3, a, b));
  assert.equal(r2.step, 'take');
  if (r2.step === 'take') { same(r2.held.state, b); assert.equal(r2.held.seq, 3); assert.ok(r2.parts?.has('tasks')); }
  assert.equal(receive(held, changes(1, 2, a, b)).step, 'skip', 'an older message');
  assert.equal(receive(held, full(1, a)).step, 'skip', 'an older whole state');
  assert.equal(receive(held, changes(3, 4, b, c)).step, 'resync', 'one was missed');
  assert.equal(receive(held, full(5, c)).step, 'take');
});

test('stateSync: a window that misses messages catches up and ends with the same state', () => {
  const r = rng(7);
  const tx = new StateSender();
  let now = recorded[0];
  let held: Held | null = null;
  const seen = { changes: 0, resync: 0 };
  // What main does when the window asks: the whole state, from which it goes on.
  const whole = () => {
    const got = receive(held, ipc(tx.full(now)));
    assert.equal(got.step, 'take');
    if (got.step === 'take') held = got.held;
  };
  const deliver = (msg: StateMsg) => {
    const got = receive(held, ipc(msg));
    if (got.step === 'take') { held = got.held; same(held.state, now); if (msg.kind === 'changes') seen.changes++; }
    if (got.step === 'resync') { seen.resync++; whole(); }
  };
  // The window asks for the whole state when it loads.
  whole();
  for (const s of recorded) {
    for (let i = 0; i < 40; i++) {
      now = r() < 0.2 ? s : edit(now, r, 1 + Math.floor(r() * 3));
      const msg = tx.next(now);
      if (r() >= 0.25) deliver(msg); // a quarter of them are lost
    }
  }
  // A lost message is noticed at the next one, which brings the window back in step.
  now = { ...now, dispatcher: { ...now.dispatcher, statusText: 'last' } };
  deliver(tx.next(now));
  same(held!.state, now);
  assert.ok(seen.changes > 100 && seen.resync > 10, JSON.stringify(seen));
});

test('stateSync: every part of the state names the panels that read it', () => {
  for (const p of Object.keys(last)) assert.ok(p in PART_PANELS, `${p} has panels`);
  assert.equal(panelsFor(['settings']).size, 11);
  assert.deepEqual([...panelsFor(['chat'])], ['chat']);
  assert.deepEqual([...panelsFor(['results', 'memos'])], ['chatIns']);
});
