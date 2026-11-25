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
 * A Worker given a new task is compacted first from here, before the task message goes out. A finished task's detail
 * matters less to the next one, and the new task then starts from a small context instead of a full one.
 * A Worker is not compacted when its task finishes: a follow-up on that task still has all of it.
 * Not lower: a compacted Worker starts again at 23K to 49K (fixed prompt, summary, files read again),
 * so compacting from much below 60K frees too little to pay for the summary.
 */
export const WORKER_TASK_COMPACT = 60_000;

/**
 * A session is compacted again only after its context grew this much since the last compaction.
 * Otherwise a session that starts above its threshold right after a compaction would be compacted every time.
 */
export const COMPACT_MIN_GROWTH = 20_000;

/** Whether a session with `tokens` of context should be compacted at threshold `at`; `floor` is its size after the last compaction. */
export function shouldCompact(tokens: number, floor: number, at: number) {
  return tokens >= at && tokens - floor >= COMPACT_MIN_GROWTH;
}

/** Tokens as "123K". */
export function kTokens(n: number) {
  return `${Math.round(n / 1000)}K`;
}
