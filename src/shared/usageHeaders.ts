// The plan usage Anthropic's API reports on every model response of a Claude subscription, in the
// `anthropic-ratelimit-unified-*` headers. A token that may not read the usage endpoint (a setup token, made for
// inference only) still gets these on a one-token request, so both windows are known for every token account.
//
//   anthropic-ratelimit-unified-5h-utilization   0..1 of the 5-hour window used
//   anthropic-ratelimit-unified-5h-reset         when it resets, epoch seconds
//   anthropic-ratelimit-unified-7d-utilization / -7d-reset   the same for the week
//   anthropic-ratelimit-unified-status           allowed | allowed_warning | rejected
//   anthropic-ratelimit-unified-5h-status / -7d-status       the same per window
//   anthropic-ratelimit-unified-reset            when a rejection ends, epoch seconds

import type { UsageWindow } from './types';

export interface UnifiedUsage {
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  /** A usage limit refused the request. */
  rejected: boolean;
  /** When that refusal ends (ms), when the headers say. */
  rejectedUntil: number | null;
}

const P = 'anthropic-ratelimit-unified-';

/** Epoch seconds (or ms) as a time in ms; null for anything else. */
function epoch(v: string | null): number | null {
  const n = Number(v);
  if (!v || !Number.isFinite(n) || n <= 0) return null;
  return n > 1e12 ? n : n * 1000;
}

function window(get: (name: string) => string | null, w: '5h' | '7d'): UsageWindow | null {
  const raw = get(`${P}${w}-utilization`);
  const u = Number(raw);
  if (raw === null || raw.trim() === '' || !Number.isFinite(u) || u < 0) return null;
  const reset = epoch(get(`${P}${w}-reset`));
  return { utilization: Math.round(u * 100), resetsAt: reset ? new Date(reset).toISOString() : null };
}

/** Read the usage headers of a response. Null when it has none (not a subscription token, or another host). */
export function readUnifiedHeaders(get: (name: string) => string | null): UnifiedUsage | null {
  const fiveHour = window(get, '5h');
  const sevenDay = window(get, '7d');
  const status = get(`${P}status`)?.trim().toLowerCase() ?? null;
  const refused = (w: '5h' | '7d') => get(`${P}${w}-status`)?.trim().toLowerCase() === 'rejected';
  if (!fiveHour && !sevenDay && !status && !refused('5h') && !refused('7d')) return null;
  const rejected = status === 'rejected' || refused('5h') || refused('7d');
  let rejectedUntil: number | null = null;
  if (rejected) {
    // The refusal's own end; otherwise the end of the window that refused, the later one if both did.
    const own = epoch(get(`${P}reset`));
    const ends = (['5h', '7d'] as const).filter(refused).map((w) => epoch(get(`${P}${w}-reset`))).filter((n): n is number => n !== null);
    rejectedUntil = own ?? (ends.length ? Math.max(...ends) : null);
  }
  return { fiveHour, sevenDay, rejected, rejectedUntil };
}
