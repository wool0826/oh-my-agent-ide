import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampSideSize, edgeKey, keySideSize, parseSideSize, sideSizeText, SIDE_MIN } from '../src/shared/sideSize';

const room = { w: 900, h: 600 };

test('side question size: kept within the minimum and the room', () => {
  assert.deepEqual(clampSideSize({ w: 100, h: 100 }, room), { w: SIDE_MIN.w, h: SIDE_MIN.h });
  assert.deepEqual(clampSideSize({ w: 2000, h: 2000 }, room), { w: 900, h: 600 });
  assert.deepEqual(clampSideSize({ w: 512.4, h: null }, room), { w: 512, h: null });
  // A room smaller than the minimum keeps the minimum.
  assert.deepEqual(clampSideSize({ w: 500, h: 500 }, { w: 200, h: 100 }), { w: SIDE_MIN.w, h: SIDE_MIN.h });
});

test('side question size: stored as "WxH", either side may be the panel\'s own', () => {
  assert.deepEqual(parseSideSize('560x480'), { w: 560, h: 480 });
  assert.deepEqual(parseSideSize('560x'), { w: 560, h: null });
  assert.deepEqual(parseSideSize(null), { w: null, h: null });
  assert.deepEqual(parseSideSize('big'), { w: null, h: null });
  assert.equal(sideSizeText({ w: 560, h: null }), '560x');
  assert.deepEqual(parseSideSize(sideSizeText({ w: 400, h: 300 })), { w: 400, h: 300 });
});

test('side question size: ← and ↑ grow it from its top-left corner, Shift by four steps', () => {
  const now = { w: 420, h: 300 };
  assert.deepEqual(keySideSize('ArrowLeft', false, now, room), { w: 436, h: 300 });
  assert.deepEqual(keySideSize('ArrowUp', true, now, room), { w: 420, h: 364 });
  assert.deepEqual(keySideSize('ArrowRight', false, now, room), { w: 404, h: 300 });
  assert.deepEqual(keySideSize('ArrowDown', false, { w: 420, h: 225 }, room), { w: 420, h: SIDE_MIN.h });
  assert.equal(keySideSize('Enter', false, now, room), null);
});

test('side question size: each edge handle takes only its own arrows', () => {
  const now = { w: 420, h: 300 };
  assert.ok(edgeKey('h', 'ArrowUp') && edgeKey('w', 'ArrowLeft'));
  assert.ok(!edgeKey('h', 'ArrowLeft') && !edgeKey('w', 'ArrowDown') && !edgeKey('w', 'Enter'));
  assert.deepEqual(keySideSize('ArrowUp', true, now, room, 'h'), { w: 420, h: 364 });
  assert.equal(keySideSize('ArrowLeft', false, now, room, 'h'), null);
  assert.deepEqual(keySideSize('ArrowLeft', false, now, room, 'w'), { w: 436, h: 300 });
  assert.equal(keySideSize('ArrowDown', false, now, room, 'w'), null);
});
