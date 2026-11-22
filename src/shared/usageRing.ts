// The toolbar's usage rings: one per account, the 7-day window outside and the 5-hour window inside.

/** Radii on the ring's 24×24 grid. The longer window gets the larger ring. */
export const RING = { sevenDay: 10, fiveHour: 5.5 } as const;

/**
 * `stroke-dasharray` that draws `percent` of a circle of radius `r`: the arc's length, then the whole circumference
 * as the gap. Null when there is nothing to draw (usage unknown, or 0%).
 */
export function ringArc(percent: number | null, r: number): string | null {
  if (percent === null || !(percent > 0)) return null;
  const c = 2 * Math.PI * r;
  return `${((Math.min(100, percent) / 100) * c).toFixed(2)} ${c.toFixed(2)}`;
}
