import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planFallback, planSummary } from '../src/shared/plan';

test('planSummary: the three lines at the top of the plan', () => {
  assert.deepEqual(planSummary('WHAT: Add a toggle.\nHOW: Edit `app.ts`.\nOUTPUT: A PR with the toggle.\n\n## Details\nMore.'), {
    what: 'Add a toggle.', how: 'Edit `app.ts`.', output: 'A PR with the toggle.',
  });
});

test('planSummary: a heading first, bold labels, list markers, any case and CRLF', () => {
  const plan = '# Plan: dark mode\r\n\r\n- **WHAT:** Add a dark theme.\r\n* **How**: Swap the CSS variables.\r\n1. output: **A themed app.**\r\n\r\n## Steps\r\n1. Do it.';
  assert.deepEqual(planSummary(plan), { what: 'Add a dark theme.', how: 'Swap the CSS variables.', output: 'A themed app.' });
  assert.deepEqual(planSummary('## WHAT: A\n> HOW: B\n__OUTPUT:__ C'), { what: 'A', how: 'B', output: 'C' });
});

test('planSummary: Korean labels and full-width colons', () => {
  assert.deepEqual(planSummary('무엇을: 토글을 추가한다.\n어떻게： 설정에 항목을 둔다.\n결과: 토글이 있는 PR.'), {
    what: '토글을 추가한다.', how: '설정에 항목을 둔다.', output: '토글이 있는 PR.',
  });
  assert.equal(planSummary('무엇: 가\n어떻게: 나\n결과물: 다')?.output, '다');
});

test('planSummary: the sentence may sit on the line below its label', () => {
  assert.deepEqual(planSummary('**WHAT:**\nAdd it.\n**HOW:**\nLike so.\n**OUTPUT:**\nA PR.'), { what: 'Add it.', how: 'Like so.', output: 'A PR.' });
});

test('planSummary: null unless all three are there near the top, outside code blocks', () => {
  assert.equal(planSummary(''), null);
  assert.equal(planSummary('# Plan\nWHAT: Add it.\nHOW: Like so.'), null);
  assert.equal(planSummary('WHAT: a\nHOW: b\n```\nOUTPUT: c\n```'), null);
  // Not a label: "Whatever:", "Output files:", and RESULT (the final-report line).
  assert.equal(planSummary('Whatever: a\nHOW: b\nOUTPUT: c'), null);
  assert.equal(planSummary('WHAT: a\nHOW: b\nOutput files: c'), null);
  assert.equal(planSummary('WHAT: a\nHOW: b\nRESULT: c'), null);
  const deep = ['# Plan', ...Array.from({ length: 25 }, (_, i) => `Line ${i}.`), 'WHAT: a', 'HOW: b', 'OUTPUT: c'].join('\n');
  assert.equal(planSummary(deep), null);
  // An empty value with no sentence below it does not count.
  assert.equal(planSummary('WHAT:\nHOW: b\nOUTPUT: c'), null);
});

test('planSummary: the first of each label wins, and long lines are clipped', () => {
  const s = planSummary(`WHAT: first\nWHAT: second\nHOW: ${'x'.repeat(400)}\nOUTPUT: c`)!;
  assert.equal(s.what, 'first');
  assert.equal(s.how.length, 240);
  assert.ok(s.how.endsWith('…'));
});

test('planFallback: title heading, then the first sentence under approach and result headings', () => {
  const plan = '# Plan: Add dark mode\n\n## Context\nThe app is dark only.\n\n## Approach\n1. Add a **theme** setting. Then swap variables.\n\n## Verification\n- Run [the tests](https://x). Check both.';
  assert.deepEqual(planFallback(plan), { what: 'Add dark mode', how: 'Add a theme setting.', output: 'Run the tests.', auto: true });
});

test('planFallback: Korean headings', () => {
  const plan = '# 계획: 다크 모드\n\n## 구현 방법\n설정을 추가합니다. 그다음 변수를 바꿉니다.\n\n## 결과\n두 테마가 있는 PR입니다.';
  assert.deepEqual(planFallback(plan), { what: '다크 모드', how: '설정을 추가합니다.', output: '두 테마가 있는 PR입니다.', auto: true });
});

test('planFallback: no headings takes the first sentences in order; nothing to take is null', () => {
  assert.deepEqual(planFallback('I will add it.\nBy editing app.ts.\nYou get a PR.'), { what: 'I will add it.', how: 'By editing app.ts.', output: 'You get a PR.', auto: true });
  assert.deepEqual(planFallback('Just one line'), { what: 'Just one line', how: '', output: '', auto: true });
  assert.equal(planFallback(''), null);
  assert.equal(planFallback('```\ncode only\n```'), null);
});

test('planFallback: keeps the lines the Worker did write, and skips a title that only says "Plan"', () => {
  assert.deepEqual(planFallback('# Plan\n\nWHAT: Add dark mode.\n\n## Approach\nSwap the variables.\n\n## Notes\nNothing else.'), {
    what: 'Add dark mode.', how: 'Swap the variables.', output: 'Nothing else.', auto: true,
  });
  assert.equal(planFallback('# Implementation plan\n\nAdd the toggle. Then test.\n\n## Steps\nEdit it.')!.what, 'Add the toggle.');
  assert.equal(planFallback('# 계획\n\n토글을 추가합니다.')!.what, '토글을 추가합니다.');
  assert.equal(planFallback('# Plan for dark mode\n\nText.')!.what, 'Plan for dark mode');
});

test('planFallback: one section that is both approach and result is not used twice', () => {
  const s = planFallback('# Change and test\n\n## Implementation and tests\nEdit the file.\nRun the tests.')!;
  assert.equal(s.how, 'Edit the file.');
  assert.equal(s.output, 'Run the tests.');
});

test('planSummary: an optional RISK line is kept with the three', () => {
  assert.deepEqual(planSummary('WHAT: One column\nHOW: Drop the split\nRISK: Visual baselines change\nOUTPUT: A merged PR'), {
    what: 'One column', how: 'Drop the split', output: 'A merged PR', risk: 'Visual baselines change',
  });
  assert.equal(planSummary('WHAT: A\nRISK: R\nOUTPUT: C'), null);
});
