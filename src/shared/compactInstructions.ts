// What the app's /compact asks the summary to keep, by session role. One line each: Claude Code reads the rest of the
// /compact line as its custom instructions.

export const DISPATCHER_COMPACT =
  'Preserve exactly: the user\'s stated preferences, principles and constraints (for example that tokens are secrets, and language rules); ' +
  'every open or pending task with its ID and state; each Worker and what it is assigned; open PRs with their number and status; ' +
  'decisions the user made and decisions still waiting on the user; questions to the user that are not answered yet; ' +
  'and the user\'s latest request, word for word.';

export const WORKER_COMPACT =
  'Preserve exactly: the task ID, its goal and its definition of done; the progress steps and which are done; ' +
  'the branch, the files changed, commits and the PR URL; decisions and constraints from the user or the Dispatcher, word for word; ' +
  'failing tests, errors and open problems; and the next steps.';

/** The /compact command, with the instructions when there are any. */
export function compactCommand(instructions?: string) {
  const text = instructions?.replace(/\s+/g, ' ').trim();
  return text ? `/compact ${text}` : '/compact';
}
