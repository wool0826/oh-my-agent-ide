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
 * prompt cache is still warm: an idle session's cache expires after an hour, and the next message then pays
 * to write the whole context again. Follow-ups also start from a small context instead of a full one.
 */
export const WORKER_IDLE_COMPACT = 100_000;

/** Tokens as "123K". */
export function kTokens(n: number) {
  return `${Math.round(n / 1000)}K`;
}
