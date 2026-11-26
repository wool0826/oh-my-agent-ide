import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeReport, parseFakeScript } from '../src/shared/fakeScript';

test('steps are read in order from the @fake lines of a message', () => {
  const steps = parseFakeScript([
    'Task: fix the tax', '@fake say Looking at the cart', '  @fake permission npm install left-pad',
    '@fake ask Split the PR? | Split | Keep as one', '@fake write notes/a.md hello\\nworld', '@fake commit Fix tax',
    '@fake wait 20', '@fake pr https://github.com/o/r/pull/7', '@fake result Rounded once.', 'not a step',
  ].join('\n'));
  assert.deepEqual(steps, [
    { do: 'say', text: 'Looking at the cart' },
    { do: 'permission', command: 'npm install left-pad' },
    { do: 'ask', question: 'Split the PR?', options: ['Split', 'Keep as one'] },
    { do: 'write', file: 'notes/a.md', content: 'hello\nworld' },
    { do: 'commit', message: 'Fix tax' },
    { do: 'wait', ms: 20 },
    { do: 'pr', url: 'https://github.com/o/r/pull/7' },
    { do: 'result', text: 'Rounded once.' },
  ]);
  assert.equal(fakeReport(steps), 'PR: https://github.com/o/r/pull/7\nRESULT: Rounded once.');
});

test('a task step carries its Worker script from the @@fake lines under it', () => {
  const steps = parseFakeScript('@fake task demo bundle=rename_api Rename in the API\n@@fake permission git push\n@@fake result Renamed.\n@fake task - Write the notes\n@fake say Two tasks made');
  assert.deepEqual(steps, [
    { do: 'task', repo: 'demo', title: 'Rename in the API', bundle: 'rename api', prompt: '@fake permission git push\n@fake result Renamed.' },
    { do: 'task', repo: null, title: 'Write the notes', bundle: null, prompt: '' },
    { do: 'say', text: 'Two tasks made' },
  ]);
});

test('what cannot be read is skipped, not guessed', () => {
  assert.deepEqual(parseFakeScript('@fake dance now\n@fake ask Only one option | A\n@fake permission\n@@fake result orphan\nplain text'), []);
  assert.equal(fakeReport([]), '');
});

test('a blocked or failed turn says so', () => {
  assert.equal(fakeReport(parseFakeScript('@fake blocked Needs the API key')), 'BLOCKED: Needs the API key');
  assert.deepEqual(parseFakeScript('@fake fail boom'), [{ do: 'fail', message: 'boom' }]);
});

test('a Worker script can declare its plan and mark steps done', () => {
  assert.deepEqual(parseFakeScript('@fake steps Read the code | Write tests |  | Open the PR\n@fake step 1\n@fake step 0\n@fake steps'), [
    { do: 'steps', steps: ['Read the code', 'Write tests', 'Open the PR'] },
    { do: 'step', n: 1 },
  ]);
});

test('a report body comes after the protocol lines and a blank line, as a real Worker writes it', () => {
  assert.equal(fakeReport(parseFakeScript('@fake result Published\n@fake link https://example.com/a\n@fake body 아티팩트: https://claude.ai/artifact/abc')),
    'RESULT: Published\nLINK: https://example.com/a\n\n아티팩트: https://claude.ai/artifact/abc');
});

test('fakeScript: pspermission asks for its command as PowerShell', () => {
  assert.deepEqual(parseFakeScript('@fake pspermission Remove-Item -Recurse .\\dist'), [{ do: 'permission', command: 'Remove-Item -Recurse .\\dist', tool: 'PowerShell' }]);
});
