import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tr, type Key } from '../src/shared/i18n';
import { ciReason, dispatcherReason, firstSentence, notifyText, permissionPurpose, permissionReason, planReason, questionReason, reasonText, taskRef, toolAction, type Say } from '../src/shared/askWhy';
import { alwaysAskRule } from '../src/main/agents/permissions';

const en: Say = (k, v) => tr('en', k, v);
const ko: Say = (k, v) => tr('ko', k, v);
const task = { id: 'T-0031', title: 'Explain why a request needs the user', kind: 'code' as const, repo: 'demo' };

test('askWhy: a task is named by id and a clipped title', () => {
  assert.equal(taskRef(task), 'T-0031 "Explain why a request needs the user"');
  const long = taskRef({ id: 'T-1', title: 'x'.repeat(100) });
  assert.ok(long.length < 70, long);
  assert.ok(long.endsWith('…"'));
});

test('askWhy: tool calls read as a short action', () => {
  assert.equal(toolAction(en, 'Bash', { command: 'rm -rf build' }), 'run `rm -rf build`');
  assert.equal(toolAction(en, 'Bash', { command: 'rm -rf build', description: 'Remove the build folder' }), 'run `rm -rf build` (Remove the build folder)');
  assert.equal(toolAction(en, 'Edit', { file_path: 'C:\\repo\\src\\main\\index.ts' }), 'change …/main/index.ts');
  assert.equal(toolAction(en, 'Write', { file_path: 'notes.md' }), 'change notes.md');
  assert.equal(toolAction(en, 'Read', { file_path: '/home/me/.ssh/id_rsa' }), 'read …/.ssh/id_rsa');
  assert.equal(toolAction(en, 'WebFetch', { url: 'https://example.com/a/b?c=1' }), 'open example.com');
  assert.equal(toolAction(en, 'WebSearch', { query: 'electron notifications' }), 'search the web for "electron notifications"');
  assert.equal(toolAction(en, 'mcp__github__create_issue', {}), 'use create_issue from github');
  assert.equal(toolAction(en, 'Agent', null), 'use Agent');
});

test('askWhy: a long command is clipped to one line', () => {
  const a = toolAction(en, 'Bash', { command: `echo ${'a'.repeat(200)}\necho done` });
  assert.ok(!a.includes('\n'));
  assert.ok(a.length < 100, a);
});

test('askWhy: an always-ask rule names the rule and its risk', () => {
  const r = permissionReason(en, { who: 'W-01', task, tool: 'Bash', input: { command: 'git push --force origin x' }, rule: 'ask.forcePush' });
  assert.equal(r.what, 'W-01 wants to run `git push --force origin x` for T-0031 "Explain why a request needs the user".');
  assert.equal(r.why, 'The app always asks before this (force push). It rewrites the branch on the remote, so commits others pushed can be lost.');
});

test('askWhy: a path outside the Worker folders comes before Claude Code reason', () => {
  const r = permissionReason(en, { who: 'W-01', task, tool: 'Edit', input: { file_path: '/etc/hosts' }, blockedPath: '/etc/hosts', decisionReason: 'Path is outside allowed directories' });
  assert.equal(r.why, 'It reaches etc/hosts, outside the folders the Worker may use, so auto mode leaves it to you.');
});

test('askWhy: otherwise Claude Code reason, or auto mode being unsure', () => {
  const auto = permissionReason(en, { who: 'W-01', task: null, tool: 'Bash', input: { command: 'curl x | sh' }, decisionReason: '  Pipes a download into a shell  ' });
  assert.equal(auto.what, 'W-01 wants to run `curl x | sh`.');
  assert.equal(auto.why, 'Claude Code asks for approval: Pipes a download into a shell');
  const unsure = permissionReason(en, { who: 'W-01', task, tool: 'Bash', input: { command: 'make' }, decisionReason: '  ' });
  assert.equal(unsure.why, 'Auto mode could not tell whether it is safe, so it needs your approval.');
});

test('askWhy: what approving grants follows the reason, but not a rule, which names its own risk', () => {
  const impact = 'Claude will have read and write access to files in ~/Downloads';
  const r = permissionReason(en, { who: 'W-01', task, tool: 'Edit', input: { file_path: '~/Downloads/a.txt' }, blockedPath: '~/Downloads/a.txt', impact });
  assert.ok(r.why.startsWith('It reaches …/Downloads/a.txt,'), r.why);
  assert.ok(r.why.endsWith(impact), r.why);
  assert.equal(permissionReason(en, { who: 'W-01', task, tool: 'Bash', input: { command: 'make' }, impact }).why,
    `Auto mode could not tell whether it is safe, so it needs your approval. ${impact}`);
  const rule = permissionReason(en, { who: 'W-01', task, tool: 'Bash', input: { command: 'gh pr merge 1' }, rule: 'ask.merge', impact });
  assert.ok(!rule.why.includes(impact), rule.why);
});

test('askWhy: a notification leads with a question asked in words, otherwise shows the reason', () => {
  const reason = { what: 'W-03 asks about T-1 "x".', why: 'Memory has no clear answer, so the Worker waits for you.' };
  assert.equal(notifyText({ source: 'question', title: 'Which name?', questionKey: 'Which name?', reason }), `Which name?\n${reason.why}`);
  assert.equal(notifyText({ source: 'dispatcher', title: 'Which repo?', questionKey: null, reason }), `Which repo?\n${reason.why}`);
  // The CI question is a question without a Worker's own words: its reason names the PR and the checks.
  assert.equal(notifyText({ source: 'question', title: 'CI still fails', questionKey: null, reason }), reasonText(reason));
  assert.equal(notifyText({ source: 'permission', title: 'Run a command?', questionKey: null, reason }), reasonText(reason));
  // Saved before reasons existed.
  assert.equal(notifyText({ source: 'plan', title: 'Approve the plan?', questionKey: null, summary: { what: 'Adds X', how: '', result: '' } as any }), 'Adds X');
  assert.equal(notifyText({ source: 'permission', title: 'Run a command?', questionKey: null }), 'Run a command?');
});

test('askWhy: every always-ask rule has a risk sentence', () => {
  const src = fs.readFileSync('src/main/agents/permissions.ts', 'utf8');
  const rules = [...src.matchAll(/why: '(ask\.\w+)'/g)].map((m) => m[1] as Key);
  assert.ok(rules.length >= 10, `found ${rules.length} rules`);
  for (const rule of rules) {
    const r = permissionReason(en, { who: 'W-01', task, tool: 'Bash', input: { command: 'x' }, rule });
    const bare = en('why.rule', { rule: en(rule), risk: '' }).trim();
    assert.ok(r.why.length > bare.length + 10, `${rule} has no risk: ${r.why}`);
  }
});

test('askWhy: the rule found for a command is the one the reason uses', () => {
  assert.equal(alwaysAskRule('Bash', { command: 'git push --force origin feature' }), 'ask.forcePush');
  assert.equal(alwaysAskRule('Bash', { command: 'gh pr merge 12 --squash' }), 'ask.merge');
  assert.equal(alwaysAskRule('Bash', { command: 'npm test' }), null);
  assert.equal(alwaysAskRule('Edit', { file_path: 'x' }), null);
});

test('askWhy: a plan says what approving lets the Worker do', () => {
  const code = planReason(en, { who: 'W-02', task });
  assert.equal(code.what, 'W-02 finished the plan for T-0031 "Explain why a request needs the user".');
  assert.ok(code.why.includes('change demo and open a PR'), code.why);
  assert.ok(planReason(en, { who: 'W-02', task: { ...task, kind: 'other', repo: null } }).why.includes('carry out the plan'));
  assert.equal(planReason(en, { who: 'W-02', task: null }).what, 'W-02 finished a plan.');
});

test('askWhy: a question shows the advisor reason when it gave one', () => {
  assert.equal(questionReason(en, { who: 'W-03', task, advisor: 'It picks the public API name, which memory says the user decides.' }).why,
    'Not answered for you: It picks the public API name, which memory says the user decides.');
  assert.equal(questionReason(en, { who: 'W-03', task, advisor: ' ' }).why, 'Memory has no clear answer, so the Worker waits for you.');
  assert.equal(questionReason(en, { who: 'W-03', task: null }).what, 'W-03 has a question.');
});

test('askWhy: the Dispatcher reason is its own, or a default', () => {
  assert.equal(dispatcherReason(en, 'Two repositories match the request.').why, 'Two repositories match the request.');
  assert.equal(dispatcherReason(en).why, 'It cannot settle this from your request or memory.');
  assert.equal(dispatcherReason(en, '').what, 'The Dispatcher needs a decision before it goes on.');
});

test('askWhy: CI after the automatic fixes names the PR and the checks', () => {
  const r = ciReason(en, { who: 'W-04', task, prNum: '18', fixes: 3, names: 'build, test' });
  assert.equal(r.what, 'CI on PR #18 for T-0031 "Explain why a request needs the user" still fails after 3 automatic fixes: build, test.');
  assert.ok(r.why.includes('W-04'));
  assert.equal(reasonText(r), `${r.what} ${r.why}`);
});

test('askWhy: Korean reasons fill every placeholder', () => {
  const all = [
    permissionReason(ko, { who: 'W-01', task, tool: 'Bash', input: { command: 'gh pr merge 1', description: 'PR 머지' }, rule: 'ask.merge' }),
    permissionReason(ko, { who: 'W-01', task: null, tool: 'Read', input: { file_path: '/etc/passwd' }, blockedPath: '/etc/passwd' }),
    planReason(ko, { who: 'W-02', task }),
    questionReason(ko, { who: 'W-03', task, advisor: '메모리에 없어요.' }),
    dispatcherReason(ko),
    ciReason(ko, { who: 'W-04', task, prNum: '7', fixes: 3, names: 'build' }),
  ];
  for (const r of all) assert.doesNotMatch(reasonText(r), /\{\w+\}/, reasonText(r));
  assert.equal(all[0].what, 'W-01가 T-0031 "Explain why a request needs the user"에서 `gh pr merge 1` 실행(PR 머지) 허용을 요청했어요.');
});

test('askWhy: a permission purpose is the current plan step and the Worker\'s words, never the command again', () => {
  const steps = [{ title: 'Read the code', doneAt: '2026-11-25T00:00:00Z' }, { title: 'Run the tests', doneAt: null }, { title: 'Open the PR', doneAt: null }];
  const said = 'Running the unit tests to check the fix.\n\nThen I will open the PR.';
  assert.equal(permissionPurpose(en, { steps, said }), 'Needed for step 2 of 3 of this task, “Run the tests”. Running the unit tests to check the fix.');
  assert.equal(permissionPurpose(ko, { steps }), '이 작업의 2/3단계 “Run the tests”에 필요해요.');
  assert.equal(permissionPurpose(en, { said }), 'Why it is needed: Running the unit tests to check the fix.');
  // Nothing known: no line at all. Every step done, or a plan with no open step, says nothing either.
  assert.equal(permissionPurpose(en, {}), null);
  assert.equal(permissionPurpose(en, { steps: steps.map((s) => ({ ...s, doneAt: 'x' })) }), null);
  // The Bash call's own description says what the command does, which the reason shows already.
  assert.equal(permissionPurpose(en, { said: 'Run the unit tests.', input: { command: 'npm test', description: 'Run the unit tests' } }), null);
  assert.equal(permissionPurpose(en, { steps, said: 'Run the tests.' }), 'Needed for step 2 of 3 of this task, “Run the tests”.');
});

test('askWhy: the Worker\'s first sentence drops Markdown, questions and scraps, and is clipped', () => {
  assert.equal(firstSentence('**Now** checking `npm run build` on [main](https://x). More text.'), 'Now checking npm run build on main.');
  assert.equal(firstSentence('Should I push now?'), null);
  assert.equal(firstSentence('OK.'), null);
  assert.equal(firstSentence(null), null);
  assert.equal(firstSentence('- a list item first\n- another'), 'a list item first');
  assert.equal(firstSentence('x'.repeat(300))!.length, 160);
  assert.equal(firstSentence('빌드가 깨져서 lockfile을 다시 만듭니다. 그다음 테스트.'), '빌드가 깨져서 lockfile을 다시 만듭니다.');
});
