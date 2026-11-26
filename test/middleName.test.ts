import { test } from 'node:test';
import assert from 'node:assert/strict';
import { middleName, nameWidth } from '../src/shared/middleName';

test('middleName: a name that fits is left as it is', () => {
  assert.equal(middleName('execution-plan.md'), 'execution-plan.md');
});

test('middleName: a long name keeps its start, its end and its extension', () => {
  const out = middleName('KakaoTalk_20261126_154210123_attachment_button_wrap.png');
  assert.ok(out.startsWith('KakaoTalk_'));
  assert.ok(out.endsWith('wrap.png'));
  assert.ok(out.includes('…'));
  assert.ok(nameWidth(out) <= 30, out);
});

test('middleName: Hangul counts two columns, so a Korean name is cut sooner', () => {
  const out = middleName('첨부버튼_두줄_깨짐_재현_화면_2026-11-26_오후_3시42분.png');
  assert.ok(out.endsWith('.png'));
  assert.ok(nameWidth(out) <= 30, out);
  assert.equal(nameWidth('가a'), 3);
});

test('middleName: a long tail after the last dot is not taken for an extension', () => {
  const out = middleName('notes.this-is-not-an-extension-at-all-really', 20);
  assert.ok(nameWidth(out) <= 20, out);
  assert.ok(out.startsWith('notes.'));
});

test('middleName: a name without an extension is cut in its middle too', () => {
  assert.equal(middleName('a'.repeat(50), 10), 'aaaaaa…aaa');
});
