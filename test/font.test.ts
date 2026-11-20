import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FONT_SIZE_DEFAULT, FONT_SIZE_MAX, FONT_SIZE_MIN, SYSTEM_FONT_STACK, clampFontSize, fontStack, normalizeFontFamily } from '../src/shared/font';

test('text size: clamps to range and rounds to whole px', () => {
  assert.equal(clampFontSize(14), 14);
  assert.equal(clampFontSize('15'), 15);
  assert.equal(clampFontSize(13.6), 14);
  assert.equal(clampFontSize(2), FONT_SIZE_MIN);
  assert.equal(clampFontSize(99), FONT_SIZE_MAX);
});

test('text size: non-numbers give the default', () => {
  for (const v of [undefined, null, '', 'abc', NaN, 0, -3]) assert.equal(clampFontSize(v), FONT_SIZE_DEFAULT);
});

test('font name: strips quotes, spaces and empty entries', () => {
  assert.equal(normalizeFontFamily('  "Noto Sans KR" ,  Pretendard ,, '), 'Noto Sans KR, Pretendard');
  assert.equal(normalizeFontFamily("'Malgun   Gothic'"), 'Malgun Gothic');
  assert.equal(normalizeFontFamily(undefined), '');
  assert.equal(normalizeFontFamily(42), '');
});

test('font name: removes characters that would break CSS', () => {
  assert.equal(normalizeFontFamily('Inter; } body { color: red'), 'Inter body color: red');
});

test('fontStack: empty gives the system fonts', () => {
  assert.equal(fontStack(''), SYSTEM_FONT_STACK);
  assert.equal(fontStack(' , '), SYSTEM_FONT_STACK);
});

test('fontStack: quotes chosen fonts and appends system fonts as fallbacks', () => {
  assert.equal(fontStack('Noto Sans KR, serif'), `"Noto Sans KR", serif, ${SYSTEM_FONT_STACK}`);
  assert.equal(fontStack('D2Coding 2.0'), `"D2Coding 2.0", ${SYSTEM_FONT_STACK}`);
});
