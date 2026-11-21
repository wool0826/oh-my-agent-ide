import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restoreScroll, saveScroll, type Scrollable } from '../src/shared/scroll';

type El = Scrollable & { bar?: number; writes: number };

/** A stand-in element that counts writes and clamps offsets the way a browser does. */
function el(key: string | undefined, top = 0, left = 0, max = Infinity): El {
  let t = top, l = left;
  return {
    dataset: key === undefined ? {} : { scroll: key },
    writes: 0,
    get scrollTop() { return t; },
    set scrollTop(v: number) { t = Math.min(Math.max(v, 0), max); this.writes++; },
    get scrollLeft() { return l; },
    set scrollLeft(v: number) { l = Math.min(Math.max(v, 0), max); this.writes++; },
  };
}

test('scroll: a rebuilt list gets its offsets back by key', () => {
  const saved = saveScroll([el('wk-list', 340), el('diff-a', 12, 80)]);
  const list = el('wk-list'), diff = el('diff-a');
  restoreScroll([diff, list], saved);
  assert.deepEqual([list.scrollTop, list.scrollLeft], [340, 0]);
  assert.deepEqual([diff.scrollTop, diff.scrollLeft], [12, 80]);
});

test('scroll: only scrolled or showing elements are saved, and only keyed ones', () => {
  const saved = saveScroll([el('top'), el('moved', 5), el(undefined, 99), el('', 7)]);
  assert.deepEqual([...saved.keys()], ['moved']);
  const showing = Object.assign(el('bar'), { bar: 700 });
  const faded = Object.assign(el('faded'), { bar: -50 });
  const saved2 = saveScroll([showing, faded], (e) => e.bar ?? 0);
  assert.deepEqual(saved2.get('bar'), { top: 0, left: 0, bar: 700 });
  assert.equal(saved2.has('faded'), false);
});

test('scroll: the first element with a key wins', () => {
  const saved = saveScroll([el('k', 10), el('k', 20)]);
  assert.equal(saved.get('k')?.top, 10);
  const a = el('k'), b = el('k');
  restoreScroll([a, b], saved);
  assert.deepEqual([a.scrollTop, b.scrollTop], [10, 0]);
});

test('scroll: an element already in place is not written to', () => {
  const kept = el('wk-list', 200);
  const moved: El[] = [];
  restoreScroll([kept], saveScroll([kept]), (e) => moved.push(e));
  assert.equal(kept.writes, 0);
  assert.deepEqual(moved, []);
});

test('scroll: moved elements are reported, and a shorter list clamps', () => {
  const saved = saveScroll([el('wk-list', 900)]);
  const short = el('wk-list', 0, 0, 300);
  const moved: El[] = [];
  restoreScroll([short], saved, (e) => moved.push(e));
  assert.equal(short.scrollTop, 300);
  assert.deepEqual(moved, [short]);
});

test('scroll: elements whose bar was showing come back with the time it had left, keys that are gone are skipped', () => {
  const old = Object.assign(el('plan-1', 40), { bar: 450 });
  const saved = saveScroll([old, el('plan-2', 8)], (e) => e.bar ?? 0);
  const p1 = el('plan-1'), other = el('plan-3');
  assert.deepEqual(restoreScroll([other, p1], saved), [[p1, 450]]);
  assert.equal(other.writes, 0);
  assert.deepEqual(restoreScroll([el('x')], new Map()), []);
});
