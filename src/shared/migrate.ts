// Moving a state file from the format it was saved in to the one this build reads, a version at a time. Pure:
// the store (main/store.ts) keeps a copy of the file before the first step of a launch, puts it back when a step
// throws, and opens a file saved by a newer build read-only.

/** The state format this build reads and writes. */
export const STATE_VERSION = 1 as const;

/** One step: a state of version N in, the same state as version N+1 out (or changed in place). */
export type MigrationStep = (state: Record<string, unknown>) => Record<string, unknown> | void;

export interface MigrationChain {
  /** The version the chain ends at. */
  version: number;
  /** `steps[n]` takes a state from version n to n+1. */
  steps: Readonly<Record<number, MigrationStep>>;
}

/** The chain this build applies on load. No steps yet: version 1 is the first format. */
export const CHAIN: MigrationChain = { version: STATE_VERSION, steps: {} };

export type MigrationResult =
  | { kind: 'current'; state: Record<string, unknown> }
  | { kind: 'migrated'; state: Record<string, unknown>; from: number; to: number }
  /** Saved by a newer build: nothing here may write over it. */
  | { kind: 'newer'; version: number }
  /** The step from `at` to `at + 1` threw (or is missing); the state as read is untouched. */
  | { kind: 'failed'; from: number; at: number; error: string };

/** The version a state says it has. One without a usable number counts as the first version. */
export function stateVersion(state: Record<string, unknown>): number {
  const v = state.version;
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 1;
}

/**
 * Brings a parsed state up to the chain's version. Each step works on a copy, so the state passed in is never
 * changed, whatever a step does before it throws.
 */
export function migrate(state: Record<string, unknown>, chain: MigrationChain = CHAIN): MigrationResult {
  const from = stateVersion(state);
  if (from > chain.version) return { kind: 'newer', version: from };
  if (from === chain.version) return { kind: 'current', state };
  let cur = structuredClone(state);
  for (let at = from; at < chain.version; at++) {
    const step = chain.steps[at];
    if (!step) return { kind: 'failed', from, at, error: `no step from version ${at} to ${at + 1}` };
    try {
      const next = step(cur) ?? cur;
      if (!next || typeof next !== 'object' || Array.isArray(next)) throw new Error('the step returned no state');
      cur = next;
    } catch (e) {
      return { kind: 'failed', from, at, error: e instanceof Error ? e.message : String(e) };
    }
    cur.version = at + 1;
  }
  return { kind: 'migrated', state: cur, from, to: chain.version };
}

/** The name of the copy kept before a launch's first migration: "state-v1-before-v2-1764000000000.json". */
export function preMigrationName(from: number, to: number, now: number): string {
  return `state-v${from}-before-v${to}-${now}.json`;
}
