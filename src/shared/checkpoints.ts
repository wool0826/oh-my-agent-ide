// Checkpoints: the state of a Worker's worktree, saved as a git ref before each message it is handed,
// so the files can be put back to how they were before a turn went wrong.

export interface Checkpoint {
  /** The git ref that holds it. */
  ref: string;
  /** When it was saved. */
  at: string;
  /** What the Worker was about to be told. */
  label: string;
  /** The saved files, as a git tree. */
  tree: string;
}

/** Where a Worker's checkpoints live in its repository. */
export const checkpointPrefix = (workerId: string) => `refs/oma/checkpoints/${workerId}/`;

/** How many checkpoints a Worker keeps. */
export const MAX_CHECKPOINTS = 20;

/** A checkpoint's name: the first line of what the Worker was about to be told, without the app's "[...]" tag. */
export function checkpointLabel(message: string, max = 70): string {
  const lines = message.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  const first = (lines[0] ?? '').replace(/^\[[^\]]*\]\s*/, '') || (lines[1] ?? '');
  const line = first.replace(/^>\s*/, '').replace(/\s+/g, ' ');
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** The format `git for-each-ref` is asked for: ref, date, tree and subject, tab-separated. */
export const CHECKPOINT_FORMAT = '%(refname)%09%(creatordate:iso-strict)%09%(tree)%09%(subject)';

/** Checkpoints from `git for-each-ref --sort=-creatordate --format=CHECKPOINT_FORMAT`, newest first. */
export function parseCheckpoints(out: string): Checkpoint[] {
  return out.split('\n').flatMap((l) => {
    const [ref, at, tree, ...rest] = l.split('\t');
    return ref && at && tree ? [{ ref: ref.trim(), at, tree, label: rest.join('\t').trim() }] : [];
  });
}

/** The refs to delete so that only the newest `keep` stay. `refs` is newest first. */
export function checkpointsToDrop(refs: readonly string[], keep = MAX_CHECKPOINTS): string[] {
  return refs.slice(keep);
}
