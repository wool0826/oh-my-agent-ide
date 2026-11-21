// What agent work cost: Claude Code's estimate at API list prices, plus tokens.
// Subscription accounts are not billed this amount, so the UI calls it an API-equivalent estimate.

export interface Spend {
  costUsd: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** The running totals Claude Code reported for one session, so its next figures can be turned into one turn's. */
export interface SessionSpend { sessionId: string; total: Spend }

type ModelUsageLike = { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number };

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** The running totals a result message carries: total_cost_usd and modelUsage, which include subagents. */
export function spendOf(r: { total_cost_usd?: number; modelUsage?: Record<string, ModelUsageLike> }): Spend {
  const s: Spend = { costUsd: num(r.total_cost_usd), input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const u of Object.values(r.modelUsage ?? {})) {
    s.input += num(u?.inputTokens);
    s.output += num(u?.outputTokens);
    s.cacheRead += num(u?.cacheReadInputTokens);
    s.cacheWrite += num(u?.cacheCreationInputTokens);
  }
  return s;
}

export function hasSpend(s: Spend | null | undefined): s is Spend {
  return !!s && (s.costUsd > 0 || s.input + s.output + s.cacheRead + s.cacheWrite > 0);
}

export function addSpend(a: Spend | null | undefined, b: Spend): Spend {
  if (!a) return { ...b };
  return { costUsd: a.costUsd + b.costUsd, input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite };
}

/**
 * What a turn added, from the session's running totals now and after the previous turn.
 * Null for an all-zero result (a crash or startup error carries zeroes), which must not move the baseline.
 * A total that went down means the session's counter started over (/clear, or a resume that had no saved totals),
 * so everything it reports now is new.
 */
export function spendSince(now: Spend, before: Spend | null): Spend | null {
  if (!hasSpend(now)) return null;
  if (!before) return { ...now };
  const keys: (keyof Spend)[] = ['costUsd', 'input', 'output', 'cacheRead', 'cacheWrite'];
  if (keys.some((k) => now[k] < before[k])) return { ...now };
  return { costUsd: now.costUsd - before.costUsd, input: now.input - before.input, output: now.output - before.output, cacheRead: now.cacheRead - before.cacheRead, cacheWrite: now.cacheWrite - before.cacheWrite };
}

/**
 * Turns one session's running totals into what each turn added. Totals carry over a resume (an app restart,
 * an account failover), so a resumed session starts from what was already counted for it.
 * Resumed without that (a session from before spend was recorded), the first totals mix earlier turns
 * with the current one and cannot be split: they only set the baseline, so old history is not charged to this task.
 */
export class SpendMeter {
  private last: Spend | null;
  private baselineOnly: boolean;

  constructor(resumed: boolean, counted: Spend | null) {
    this.last = counted;
    this.baselineOnly = resumed && !counted;
  }

  /** The totals counted so far, to save for the next resume. */
  get total() { return this.last; }

  /** What this result added (zero when it only set the baseline); null when it must be ignored. */
  take(now: Spend): Spend | null {
    const turn = spendSince(now, this.last);
    if (!turn) return null;
    this.last = now;
    if (this.baselineOnly) {
      this.baselineOnly = false;
      return { costUsd: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    }
    return turn;
  }
}

export function formatUsd(n: number) {
  if (!(n > 0)) return '$0';
  if (n < 0.01) return '<$0.01';
  return n < 100 ? `$${n.toFixed(2)}` : `$${Math.round(n).toLocaleString('en-US')}`;
}

export function formatTokens(n: number) {
  const one = (x: number) => x.toFixed(1).replace(/\.0$/, '');
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${one(n / 1000)}K`;
  if (n < 999_500) return `${Math.round(n / 1000)}K`;
  if (n < 10_000_000) return `${one(n / 1e6)}M`;
  return `${Math.round(n / 1e6)}M`;
}

/** Formatted values for the spend.* texts. */
export function spendVars(s: Spend) {
  return {
    cost: formatUsd(s.costUsd),
    in: formatTokens(s.input),
    out: formatTokens(s.output),
    cache: formatTokens(s.cacheRead + s.cacheWrite),
    read: formatTokens(s.cacheRead),
    write: formatTokens(s.cacheWrite),
  };
}
