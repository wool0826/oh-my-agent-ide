import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FONT_SIZE_DEFAULT, FONT_SIZE_MAX, FONT_SIZE_MIN, SYSTEM_FONT_STACK, clampFontSize, fontStack, normalizeFontFamily } from '../src/shared/font';

test('글자 크기: 범위 안으로 맞추고 정수로 반올림한다', () => {
  assert.equal(clampFontSize(14), 14);
  assert.equal(clampFontSize('15'), 15);
  assert.equal(clampFontSize(13.6), 14);
  assert.equal(clampFontSize(2), FONT_SIZE_MIN);
  assert.equal(clampFontSize(99), FONT_SIZE_MAX);
});

test('글자 크기: 숫자가 아니면 기본값', () => {
  for (const v of [undefined, null, '', 'abc', NaN, 0, -3]) assert.equal(clampFontSize(v), FONT_SIZE_DEFAULT);
});

test('글꼴 이름: 따옴표, 공백, 빈 항목을 정리한다', () => {
  assert.equal(normalizeFontFamily('  "Noto Sans KR" ,  Pretendard ,, '), 'Noto Sans KR, Pretendard');
  assert.equal(normalizeFontFamily("'Malgun   Gothic'"), 'Malgun Gothic');
  assert.equal(normalizeFontFamily(undefined), '');
  assert.equal(normalizeFontFamily(42), '');
});

test('글꼴 이름: CSS를 깨뜨리는 문자는 걷어 낸다', () => {
  assert.equal(normalizeFontFamily('Inter; } body { color: red'), 'Inter body color: red');
});

test('fontStack: 비어 있으면 시스템 글꼴', () => {
  assert.equal(fontStack(''), SYSTEM_FONT_STACK);
  assert.equal(fontStack(' , '), SYSTEM_FONT_STACK);
});

test('fontStack: 고른 글꼴을 따옴표로 감싸고 시스템 글꼴을 대체 글꼴로 붙인다', () => {
  assert.equal(fontStack('Noto Sans KR, serif'), `"Noto Sans KR", serif, ${SYSTEM_FONT_STACK}`);
  assert.equal(fontStack('D2Coding 2.0'), `"D2Coding 2.0", ${SYSTEM_FONT_STACK}`);
});
