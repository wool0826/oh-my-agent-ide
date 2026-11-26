import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alreadySaved, cleanDecisionFile, noiseLine, worthRemembering } from '../src/shared/decisionMemory';
import { ALLOW, ALLOW_TASK, DENY, type Decision } from '../src/shared/types';

const d = (source: Decision['source'], title: string, answer: string | null, kind?: 'ci') => ({ source, title, answer, kind });

test('decisionMemory: a permission is never kept, whatever was answered', () => {
  for (const ans of [ALLOW, ALLOW_TASK, DENY, 'Not on main, use the branch']) assert.equal(worthRemembering(d('permission', 'Run this command?', ans)), false);
  assert.equal(worthRemembering(d('permission', 'Allow recall?', ALLOW)), false);
});

test('decisionMemory: a plan approved as it was is not kept; a plan sent back with a change is', () => {
  assert.equal(worthRemembering(d('plan', 'Review the plan', ALLOW)), false);
  assert.equal(worthRemembering(d('plan', 'Review the plan', 'Explain it again in Korean')), true);
});

test('decisionMemory: the CI keep-fixing question is not kept', () => {
  assert.equal(worthRemembering(d('question', 'CI still fails after 3 automatic fixes. Keep fixing?', 'Keep fixing', 'ci')), false);
});

test("decisionMemory: the Dispatcher's request_decision and a Worker's question are kept", () => {
  assert.equal(worthRemembering(d('dispatcher', 'Push the v0.7.0 tag?', 'hold: test it first')), true);
  assert.equal(worthRemembering(d('dispatcher', 'Which mock-up for the inbox?', 'Option B')), true);
  assert.equal(worthRemembering(d('question', 'Split the PR in two?', 'Keep as one')), true);
  // A yes or no is kept when the question says what it is about.
  assert.equal(worthRemembering(d('dispatcher', 'Shall I quit the Electron processes?', 'Yes')), true);
});

test('decisionMemory: no question text, no answer, or a bare yes to a question that names nothing is not kept', () => {
  assert.equal(worthRemembering(d('dispatcher', '  ', 'Option B')), false);
  assert.equal(worthRemembering(d('question', 'Which side?', '')), false);
  assert.equal(worthRemembering(d('question', 'Which side?', null)), false);
  assert.equal(worthRemembering(d('dispatcher', 'Continue?', 'Yes')), false);
  assert.equal(worthRemembering(d('question', '계속할까요?', '네')), false);
});

test('decisionMemory: old lines are noise by the words the app wrote, in either language', () => {
  for (const line of [
    '- W-06: Run this command? → Allow _(2026-11-24)_',
    '- W-02, W-05, W-07, W-21: Run this command? → Allow _(2026-11-22)_',
    '- W-12, W-16, W-22: Allow recall? → Allow _(2026-11-21)_',
    '- W-03: Change these files? → Deny _(2026-11-23)_',
    '- W-04: 이 명령을 실행해도 될까요? → 허용 _(2026-11-23)_',
    '- W-04: recall 실행을 허용할까요? → 이 작업 동안 허용 _(2026-11-23)_',
    '- W-20: Review the plan → Approve plan _(2026-11-26)_',
    '- W-20: 계획 검토 → 계획 승인 _(2026-11-26)_',
    '- W-01: CI still fails after 3 automatic fixes. Keep fixing? → Keep fixing _(2026-11-25)_',
    '- Dispatcher: Continue? → Yes _(2026-11-25)_',
  ]) assert.equal(noiseLine(line), true, line);
  for (const line of [
    '- Dispatcher: Push the v0.7.0 tag? → hold: test it first _(2026-11-26)_',
    '- W-12: Review the plan → Summarise it and pass it to the Dispatcher _(2026-11-21)_',
    '- The memory remote is https://example.com/memory.git. _(2026-11-20)_',
    '# Decisions 2026-11',
    '',
  ]) assert.equal(noiseLine(line), false, line);
});

test('decisionMemory: clean-up drops noise and second copies, keeps the first copy, headings and real decisions', () => {
  const before = [
    '# Decisions 2026-11',
    '',
    '- The memory remote is https://example.com/memory.git. _(2026-11-20)_',
    '- W-05: Run this command? → Allow _(2026-11-23)_',
    '- Dispatcher: Push the v0.7.0 tag? → hold: test it first _(2026-11-24)_',
    '- W-05: Run this command? → Allow _(2026-11-23)_',
    '- W-19: Review the plan → Approve plan _(2026-11-26)_',
    '- Dispatcher: Push the v0.7.0 tag? → hold: test it first _(2026-11-26)_',
    '- A note on two lines',
    '  with its second line _(2026-11-26)_',
    '',
  ].join('\n');
  const r = cleanDecisionFile(before);
  assert.deepEqual([r.removed, r.noise, r.repeats], [4, 3, 1]);
  assert.equal(r.text, [
    '# Decisions 2026-11',
    '',
    '- The memory remote is https://example.com/memory.git. _(2026-11-20)_',
    '- Dispatcher: Push the v0.7.0 tag? → hold: test it first _(2026-11-24)_',
    '- A note on two lines',
    '  with its second line _(2026-11-26)_',
    '',
  ].join('\n'));
  // Cleaned once, there is nothing left to take out, and the text is handed back as it was.
  assert.deepEqual(cleanDecisionFile(r.text), { text: r.text, removed: 0, noise: 0, repeats: 0 });
  assert.equal(cleanDecisionFile(before.replace(/\n/g, '\r\n')).removed, 4, 'lines ended with CRLF too');
});

test('decisionMemory: a decision saved on another day is already saved', () => {
  const file = '# Decisions 2026-11\n\n- Dispatcher: Push the tag? → hold _(2026-11-24)_\n';
  assert.equal(alreadySaved(file, 'Dispatcher: Push the tag? → hold'), true);
  assert.equal(alreadySaved(file, 'Dispatcher: Push the tag? → push'), false);
  assert.equal(alreadySaved(file, 'Decisions 2026-11'), false, 'a heading is not an entry');
});
