import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';

/** A change within both limits skips the self-review. Lockfiles and generated files are not counted. */
export const SELF_REVIEW_SKIP = { lines: 30, files: 3 };
/** The reviewer subagent every Worker session gets. */
export const REVIEWER = 'self-reviewer';
/** The skill in resources/plugin/skills/self-review (plugin skills are prefixed with the plugin name). */
export const SELF_REVIEW_SKILL = 'oh-my-agent-ide:self-review';

/**
 * The task-message line asking a code task to review its diff before `gh pr create`. Null when Settings turned it off.
 * It goes in the task message, not the system prompt, so a changed setting applies from the next task
 * without restarting a Worker's session.
 */
export function selfReviewLine(enabled: boolean, defaultBranch: string, local = false): string | null {
  if (!enabled) return null;
  const { lines, files } = SELF_REVIEW_SKIP;
  // A local-only repository has no origin and no PR: the review runs against the local branch before the report.
  return [
    local
      ? `Self-review: before your final report, follow the \`${SELF_REVIEW_SKILL}\` skill against \`${defaultBranch}\`.`
      : `Self-review: before \`gh pr create\`, follow the \`${SELF_REVIEW_SKILL}\` skill against \`origin/${defaultBranch}\`.`,
    `Skip it when the change is at most ${lines} changed lines in at most ${files} files (lockfiles and generated files not counted) or touches only docs or comments.`,
    `Either way, put its one-line result in ${local ? 'your report' : 'the PR body'}.`,
  ].join(' ');
}

/** Read-only reviewer on a lighter model (the Dispatcher's), started by the self-review skill. */
export function reviewerAgent(model: string): AgentDefinition {
  return {
    description: 'Read-only reviewer for the self-review step before opening a PR. Use it only when the self-review skill tells you to.',
    model,
    effort: 'medium',
    maxTurns: 25,
    tools: ['Bash', 'Read', 'Grep', 'Glob'],
    prompt: [
      'You review a branch before its PR is opened. You are read-only: never edit files, commit, push, or run a command that changes anything. Use Bash only for git diff, git log, git show and similar reads.',
      'Read the diff with the command in the request (for example `git diff origin/main...HEAD`). Open surrounding code only where you need it to judge a change.',
      "Look for: correctness bugs, unhandled edge cases (empty, null, errors, concurrency), security problems, changed behavior without a test, leftover debug code, changes outside the task's scope, and breaks of the repository's CLAUDE.md conventions.",
      'Skip style nits and anything a linter or formatter would catch. Do not praise or summarize the change.',
      'Reply with at most 8 findings, most severe first, one line each: `must-fix` or `consider`, then `file:line`, the problem, and the fix. If there is nothing worth fixing, reply exactly `No findings.`',
    ].join('\n'),
  };
}
