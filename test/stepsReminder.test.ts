// The one-time reminder to declare progress steps (agents/stepsReminder.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REMIND_AFTER, STEPS_REMINDER, stepsReminder, stepsReminderHook } from '../src/main/agents/stepsReminder';
import type { Task } from '../src/shared/types';

const T = (over: Partial<Task> = {}) => ({ id: 'T-1', status: 'running', steps: null, ...over }) as Task;

test('stepsReminder: fires once, on the REMIND_AFTER-th tool call of a running task with no steps', () => {
  const counts = new Map<string, number>();
  const x = T();
  const got = Array.from({ length: REMIND_AFTER + 3 }, () => stepsReminder(counts, x, 'Read'));
  assert.deepEqual(got.map((g, i) => (g ? i + 1 : 0)).filter(Boolean), [REMIND_AFTER]);
  assert.equal(got[REMIND_AFTER - 1], STEPS_REMINDER);
});

test('stepsReminder: never for a task with steps, a task not running, no task, or the step tools themselves', () => {
  const counts = new Map<string, number>();
  const withSteps = T({ steps: [{ title: 'a', doneAt: null }] });
  const waiting = T({ id: 'T-2', status: 'waiting' });
  for (let i = 0; i < REMIND_AFTER * 2; i++) {
    assert.equal(stepsReminder(counts, withSteps, 'Bash'), null);
    assert.equal(stepsReminder(counts, waiting, 'Bash'), null);
    assert.equal(stepsReminder(counts, null, 'Bash'), null);
    assert.equal(stepsReminder(counts, T({ id: 'T-3' }), 'mcp__oma__set_steps'), null);
  }
  assert.equal(counts.size, 0);
});

test('stepsReminderHook: adds the reminder as context to a PostToolUse result only', async () => {
  const hook = stepsReminderHook((tool) => (tool === 'Bash' ? 'remind' : null)).hooks[0];
  const opts = { signal: new AbortController().signal };
  const post = (tool_name: string) => ({ hook_event_name: 'PostToolUse', tool_name, tool_input: {}, tool_response: '', session_id: 's', transcript_path: '', cwd: '' }) as never;
  assert.deepEqual(await hook(post('Bash'), undefined, opts), { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'remind' } });
  assert.deepEqual(await hook(post('Read'), undefined, opts), {});
  assert.deepEqual(await hook({ ...(post('Bash') as object), hook_event_name: 'PreToolUse' } as never, undefined, opts), {});
});
