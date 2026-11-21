// Context size of a session (Dispatcher or Worker), shared by the main process and the renderer.

/**
 * The window each session runs in. Current models have a 1M window, so Claude Code's own auto-compaction
 * would wait until about 967K. Passed as `autoCompactWindow`, it makes Claude Code compact by itself,
 * mid-turn too, once the context passes this window minus its 33K reserve (217K). A model with a smaller
 * window keeps its own. The context indicator shows usage against this.
 */
export const CONTEXT_WINDOW = 250_000;

/** When a turn ends at or above this (80% of the window), the idle session is compacted. */
export const COMPACT_AT = Math.round(CONTEXT_WINDOW * 0.8);

/**
 * A Worker with no open task is compacted from here. Its task is done, so the detail matters less, and its
 * prompt cache is still warm: a Worker's cache lasts 5 minutes (WORKER_ENV in workers.ts), so the next message
 * pays to write the whole context again. Follow-ups also start from a small context instead of a full one.
 * Not lower: a compacted Worker starts again at 23K to 49K (fixed prompt, summary, files read again),
 * so compacting from much below 60K frees too little to pay for the summary.
 */
export const WORKER_IDLE_COMPACT = 60_000;

/**
 * An idle session is compacted again only after its context grew this much since the last compaction.
 * Otherwise a session that starts above its threshold right after a compaction would be compacted after every turn.
 */
export const COMPACT_MIN_GROWTH = 20_000;

/** Tokens as "123K". */
export function kTokens(n: number) {
  return `${Math.round(n / 1000)}K`;
}
