import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EV_BADGE_KEYS, EV_KINDS, eventBlocks, eventFolded, evBadge, isEventLine, needsUser, type ChatEv, type EvItem } from '../src/shared/chatEvents';
import { en, ko } from '../src/shared/i18n/chat';

const T0 = Date.parse('2026-11-26T23:21:58Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const ev = (id: string, s: number, e?: ChatEv, kind = 'event'): EvItem => ({ id, ts: at(s), kind, ...(e ? { ev: e } : {}) });
const msg = (id: string, s: number, kind = 'dispatcher'): EvItem => ({ id, ts: at(s), kind });

/** The mock-up's burst: a merge and the start it caused, five more, then a failure and a usage limit. */
const burst = () => [
  ev('m', 0, { k: 'merged', task: 'T-0136', pr: 203 }),
  ev('s', 1, { k: 'started', task: 'T-0140', worker: 'W-17', dep: 'T-0136' }),
  ev('c', 12, { k: 'ci', task: 'T-0135', n: 1, max: 3 }),
  ev('r', 21, { k: 'review', task: 'T-0134', n: 2 }),
  ev('y', 29, { k: 'memory', title: 'PR titles in English' }),
  ev('i', 33, { k: 'stalled', task: 'T-0138', n: 12 }),
  ev('f', 46, { k: 'failed', task: 'T-0133', n: 3, max: 5 }, 'error'),
  ev('l', 54, { k: 'limitPaused', note: '23:40' }),
];

test('chatEvents: event lines are events and errors, not hand-outs or messages', () => {
  assert.equal(isEventLine(ev('a', 0)), true);
  assert.equal(isEventLine(ev('b', 0, undefined, 'error')), true);
  assert.equal(isEventLine({ ...ev('c', 0), sub: 'handout' }), false);
  assert.equal(isEventLine(msg('d', 0)), false);
  assert.equal(isEventLine(msg('e', 0, 'decision')), false);
});

test('chatEvents: errors, failures and usage limits need the user; a merge or a stall does not', () => {
  assert.equal(needsUser(ev('a', 0, undefined, 'error')), true);
  assert.equal(needsUser(ev('b', 0, { k: 'limitHeld' })), true);
  assert.equal(needsUser(ev('c', 0, { k: 'planMissing' })), true);
  assert.equal(needsUser(ev('d', 0, { k: 'merged' })), false);
  assert.equal(needsUser(ev('e', 0, { k: 'stalled' })), false);
  assert.equal(needsUser(ev('f', 0)), false);
});

test('chatEvents: a burst folds into one block keyed by its first line, with the failure and the limit pinned outside', () => {
  const blocks = eventBlocks(burst());
  assert.deepEqual([...blocks.keys()], ['m']);
  const b = blocks.get('m')!;
  assert.equal(b.fold, true);
  assert.equal(b.n, 6);
  assert.deepEqual(b.pinned.map((c) => c.id), ['f', 'l']);
  assert.deepEqual(b.rows.map((r) => r.c.id), ['m', 'c', 'r', 'y', 'i']);
  assert.equal(b.from, at(0));
  assert.equal(b.to, at(54));
});

test('chatEvents: a start after a merge hangs under that merge (cause and effect)', () => {
  const b = eventBlocks(burst()).get('m')!;
  assert.deepEqual(b.rows[0].then.map((c) => c.id), ['s']);
  assert.deepEqual(b.rows.slice(1).map((r) => r.then.length), [0, 0, 0, 0]);
});

test('chatEvents: a start whose dependency is not in the run stays its own row', () => {
  const b = eventBlocks([ev('a', 0, { k: 'ci', task: 'T-1' }), ev('b', 1, { k: 'started', task: 'T-2', dep: 'T-9' }), ev('c', 2, { k: 'review', task: 'T-3' })]).get('a')!;
  assert.deepEqual(b.rows.map((r) => r.c.id), ['a', 'b', 'c']);
});

test('chatEvents: the fold counts its events by icon, in the order they first show up', () => {
  const b = eventBlocks([
    ...burst(),
    ev('x', 55, { k: 'cancelled', task: 'T-1' }),
    ev('z', 56, { k: 'followers', n: 2 }),
  ]).get('m')!;
  assert.deepEqual(b.counts.map((n) => [n.icon, n.n]), [['merged', 1], ['started', 1], ['ci', 1], ['bubble', 1], ['memory', 1], ['clock', 1], ['cancel', 2]]);
  assert.deepEqual(b.counts.find((n) => n.icon === 'cancel')!.kinds, ['cancelled', 'followers']);
  assert.equal(b.counts.find((n) => n.icon === 'clock')!.tone, 'warning');
});

test('chatEvents: fewer than 3 events that do not need the user stay rows in time order, nothing pinned', () => {
  const b = eventBlocks([ev('a', 0, { k: 'merged', task: 'T-1' }), ev('f', 3, { k: 'failed', task: 'T-2' }, 'error'), ev('b', 4, { k: 'started', task: 'T-3', dep: 'T-1' })]).get('a')!;
  assert.equal(b.fold, false);
  assert.equal(b.n, 3);
  assert.deepEqual(b.pinned, []);
  assert.deepEqual(b.rows.map((r) => [r.c.id, r.then.map((x) => x.id)]), [['a', ['b']], ['f', []]]);
});

test('chatEvents: a message between events ends the run', () => {
  const blocks = eventBlocks([ev('a', 0), ev('b', 1), msg('d', 2), ev('c', 3), ev('e', 4), ev('g', 5)]);
  assert.deepEqual([...blocks.keys()], ['a', 'c']);
  assert.equal(blocks.get('a')!.fold, false);
  assert.equal(blocks.get('c')!.fold, true);
});

test('chatEvents: a line more than 60 s after the first of its run starts the next one', () => {
  const blocks = eventBlocks([ev('a', 0), ev('b', 30), ev('c', 60), ev('d', 61), ev('e', 90), ev('f', 100)]);
  assert.deepEqual([...blocks.keys()], ['a', 'd']);
  assert.deepEqual(blocks.get('a')!.rows.map((r) => r.c.id), ['a', 'b', 'c']);
  assert.deepEqual(blocks.get('d')!.rows.map((r) => r.c.id), ['d', 'e', 'f']);
});

test('chatEvents: lines saved before the parts were kept fold too, counted under one icon', () => {
  const b = eventBlocks([ev('a', 0), ev('b', 1), ev('c', 2)]).get('a')!;
  assert.equal(b.fold, true);
  assert.deepEqual(b.counts.map((n) => [n.icon, n.n, n.kinds.length]), [['refresh', 3, 0]]);
});

test('chatEvents: eventFolded names every line drawn inside another line\'s block', () => {
  const blocks = eventBlocks([...burst(), msg('d', 70), ev('q', 71)]);
  assert.deepEqual([...eventFolded(blocks)].sort(), ['c', 'f', 'i', 'l', 'r', 's', 'y']);
});

test('chatEvents: the badge picks its words by kind and values', () => {
  assert.deepEqual(evBadge({ k: 'merged', pr: 203 }), { key: 'evb.mergedPr', vars: { n: 0, max: 0, pr: 203, note: '' } });
  assert.equal(evBadge({ k: 'merged' }).key, 'evb.merged');
  assert.equal(evBadge({ k: 'ci', n: 1, max: 3 }).key, 'evb.ci');
  assert.equal(evBadge({ k: 'failed', n: 3, max: 5 }).key, 'evb.failedAt');
  assert.equal(evBadge({ k: 'limitPaused', note: '23:40' }).key, 'evb.until');
  assert.equal(evBadge({ k: 'kept', alt: true }).key, 'evb.uncommitted');
  assert.equal(evBadge({ k: 'asked' }).key, 'evb.asked');
});

test('chatEvents: every badge key and every kind label has English and Korean words', () => {
  const keys = [...EV_BADGE_KEYS, ...Object.keys(EV_KINDS).map((k) => `evk.${k}`)];
  for (const k of keys) {
    assert.ok(k in en, `en ${k}`);
    assert.ok(k in ko, `ko ${k}`);
  }
});
