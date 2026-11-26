// Progress steps are required of every Worker task. The task message asks for them, and a Claude Code Worker that
// has made REMIND_AFTER tool calls on a running task without declaring any is reminded once, through the result of
// its next tool call (a PostToolUse hook), so its turn is not interrupted. Kept apart from workers.ts to be tested.
import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import { reopenSteps, stepView } from '../../shared/steps';
import type { Task } from '../../shared/types';

export const STEPS_TASK_LINE = 'Progress: declare your expected steps with set_steps within your first few actions, even for a small task, and call step_done as each one finishes.';

/**
 * The progress line for a follow-up that sets a task going again (review comments, a CI failure, a merge conflict, a
 * Dispatcher follow-up): a finished task starts a new round, so steps are asked for as in a task message; a task cut
 * short keeps its plan, which is to be revised rather than replaced (setSteps). Read before the task is reopened.
 */
export function followUpStepsLine(task: Task): string {
  const next = { ...task };
  reopenSteps(next, 'running');
  const v = stepView(next);
  if (!v || v.allDone) return STEPS_TASK_LINE;
  return `Progress: this task keeps its plan (${v.done}/${v.total} done). Revise it with set_steps if the work changed, keeping the done steps, and call step_done as each one finishes.`;
}

export const STEPS_REMINDER = 'Reminder from Oh My Agent IDE: you have not declared progress steps for this task. Call set_steps now with your expected steps (at least 2), then call step_done as each one finishes.';

export const REMIND_AFTER = 6;

const isStepTool = (name: string) => /(^|__)(set_steps|step_done)$/.test(name);

/**
 * Counts a Worker's tool calls per task and returns the reminder once, on the REMIND_AFTER-th call of a running task
 * that has no steps. `counts` maps a task id to its calls so far; a task that has steps is never counted.
 */
export function stepsReminder(counts: Map<string, number>, task: Task | null, toolName: string): string | null {
  if (!task || task.status !== 'running' || task.steps?.length || isStepTool(toolName)) return null;
  const n = (counts.get(task.id) ?? 0) + 1;
  counts.set(task.id, n);
  return n === REMIND_AFTER ? STEPS_REMINDER : null;
}

/** The PostToolUse hook that adds the reminder to a tool result. */
export function stepsReminderHook(remind: (toolName: string) => string | null): HookCallbackMatcher {
  return {
    hooks: [async (input) => {
      // A subagent's calls (a search, the self-review) are not the Worker's own and do not count.
      if (input.hook_event_name !== 'PostToolUse' || input.agent_id) return {};
      const text = remind(input.tool_name);
      return text ? { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } } : {};
    }],
  };
}
