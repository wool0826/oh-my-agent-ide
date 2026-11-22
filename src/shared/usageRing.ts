// The toolbar's usage rings: one per account, the 5-hour window outside and the 7-day window inside.

/** Radii on the ring's 24×24 grid. The 5-hour window, the one that runs out first, gets the larger ring. */
export const RING = { fiveHour: 10, sevenDay: 5.5 } as const;

/**
 * `stroke-dasharray` that draws `percent` of a circle of radius `r`: the arc's length, then the whole circumference
 * as the gap. Null when there is nothing to draw (usage unknown, or 0%).
 */
export function ringArc(percent: number | null, r: number): string | null {
  if (percent === null || !(percent > 0)) return null;
  const c = 2 * Math.PI * r;
  return `${((Math.min(100, percent) / 100) * c).toFixed(2)} ${c.toFixed(2)}`;
}

/**
 * How long until a usage window resets, as its two largest units: days and hours, hours and minutes, or minutes.
 * Null when the time is unknown or already past.
 */
export function untilReset(resetsAt: string | null, now = Date.now()): { unit: 'd' | 'h' | 'm'; n: number }[] | null {
  if (!resetsAt) return null;
  const mins = Math.ceil((Date.parse(resetsAt) - now) / 60_000);
  if (!(mins > 0)) return null;
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
  const parts = [{ unit: 'd' as const, n: d }, { unit: 'h' as const, n: h }, { unit: 'm' as const, n: m }];
  const from = parts.findIndex((p) => p.n > 0);
  return parts.slice(from, from + 2).filter((p) => p.n > 0);
}
