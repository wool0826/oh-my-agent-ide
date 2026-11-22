// When the PR monitor looks again, and the one cheap call that reads every watched PR's state.

export const PR_POLL = {
  /** While some PR is open (and so maybe a task waits for its merge). */
  fast: 20_000,
  /** Nothing to watch: only put-off branch cleanups are tried again. */
  slow: 3 * 60_000,
  /** The full check (CI, conflicts, review comments: one or more calls per PR) at most this often, unless asked for. */
  full: 2 * 60_000,
  /** Longest wait after errors in a row (offline, rate limit, gh logged out). */
  max: 10 * 60_000,
  /** Coming back to the window checks at once, but not more often than this. */
  focus: 10_000,
  /** PRs fully checked at the same time. */
  parallel: 3,
};

/** Milliseconds to the next round: fast while a PR is watched, slow otherwise, doubled for each failed round in a row. */
export function nextPollDelay(watching: boolean, failures: number): number {
  const base = watching ? PR_POLL.fast : PR_POLL.slow;
  if (failures <= 0) return base;
  return Math.min(PR_POLL.max, Math.max(base, PR_POLL.fast * 2 ** failures));
}

/** This round also reads CI, conflicts and comments: asked for, or the last full round is old enough. */
export function isFullRound(now: number, lastFull: number, asked: boolean): boolean {
  return asked || now - lastFull >= PR_POLL.full;
}

/** gh failed because GitHub is limiting the calls: the next rounds wait longer. */
export function isRateLimited(stderr: string): boolean {
  return /rate limit|secondary rate|abuse detection|HTTP 429/i.test(stderr);
}

export interface PrRef { host: string; owner: string; repo: string; num: string }
export interface PrState { state: 'OPEN' | 'MERGED' | 'CLOSED'; headRefName: string }

export function parsePrUrl(url: string): PrRef | null {
  const m = url.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  return m ? { host: m[1], owner: m[2], repo: m[3], num: m[4] } : null;
}

const SAFE = /^[A-Za-z0-9._-]+$/;

/**
 * One GraphQL query per host for the state of every PR, instead of one `gh pr view` each.
 * `keys` maps each `rN.pN` alias back to the PR's URL. URLs with odd owner or repo names are left out (the full check reads them).
 */
export function prStateQueries(urls: string[]): { host: string; query: string; keys: Map<string, string> }[] {
  const hosts = new Map<string, Map<string, { owner: string; repo: string; prs: Map<string, string> }>>();
  for (const url of new Set(urls)) {
    const p = parsePrUrl(url);
    if (!p || !SAFE.test(p.owner) || !SAFE.test(p.repo)) continue;
    const repos = hosts.get(p.host) ?? new Map();
    hosts.set(p.host, repos);
    const key = `${p.owner}/${p.repo}`;
    const r = repos.get(key) ?? { owner: p.owner, repo: p.repo, prs: new Map() };
    repos.set(key, r);
    r.prs.set(p.num, url);
  }
  const out: { host: string; query: string; keys: Map<string, string> }[] = [];
  for (const [host, repos] of hosts) {
    const keys = new Map<string, string>();
    const parts = [...repos.values()].map((r, i) => {
      const prs = [...r.prs].map(([num, url]) => { keys.set(`r${i}.p${num}`, url); return `p${num}: pullRequest(number: ${num}) { state headRefName }`; });
      return `r${i}: repository(owner: "${r.owner}", name: "${r.repo}") { ${prs.join(' ')} }`;
    });
    out.push({ host, query: `query { ${parts.join(' ')} }`, keys });
  }
  return out;
}

/**
 * The states the query's answer holds, by PR URL. A PR it could not read (deleted, no access) is missing.
 * Null when there is no answer at all (not JSON, or no `data`): the call failed.
 */
export function readPrStates(stdout: string, keys: Map<string, string>): Map<string, PrState> | null {
  const out = new Map<string, PrState>();
  let data: Record<string, Record<string, PrState | null> | null> | undefined;
  try { data = (JSON.parse(stdout) as { data?: typeof data }).data; } catch { return null; }
  if (!data || typeof data !== 'object') return null;
  for (const [alias, url] of keys) {
    const [r, p] = alias.split('.');
    const pr = data[r]?.[p];
    if (pr && (pr.state === 'OPEN' || pr.state === 'MERGED' || pr.state === 'CLOSED')) out.set(url, { state: pr.state, headRefName: pr.headRefName ?? '' });
  }
  return out;
}

/** Run `fn` over the items, at most `limit` at a time. */
export async function eachLimited<T>(items: T[], limit: number, fn: (x: T) => Promise<unknown>): Promise<void> {
  let next = 0;
  const lane = async () => { while (next < items.length) { const x = items[next++]; await fn(x); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}
