// Is there a newer release than the one running? (decision 120)
// The app only finds out and links to the release page; downloading and installing stay with the user.

/** The GitHub repository whose releases hold the installers. */
export const RELEASE_REPO = 'wool0826/oh-my-agent-ide';
export const RELEASE_API = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`;

export interface UpdateInfo {
  /** The newer version, without the tag's "v". */
  version: string;
  /** The release page. */
  url: string;
}

/** "v0.4.1" or "0.4.1" as numbers; null when it is not three plain numbers (a pre-release tag, a typo). */
export function parseVersion(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/**
 * The update to offer from GitHub's "latest release" answer, or null: nothing newer, a draft or pre-release,
 * or an answer that is not a release (no releases yet, a rate limit).
 */
export function updateFrom(release: unknown, current: string): UpdateInfo | null {
  const r = (release ?? {}) as { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown };
  if (typeof r.tag_name !== 'string' || typeof r.html_url !== 'string' || r.draft || r.prerelease) return null;
  if (!/^https:\/\/github\.com\//.test(r.html_url) || !isNewer(r.tag_name, current)) return null;
  return { version: r.tag_name.trim().replace(/^v/, ''), url: r.html_url };
}

// In-app updates (decision 212): Windows downloads a release with electron-updater and installs it when the app quits,
// or at once when the user asks and nothing is working. macOS keeps the link until the app is signed.

/** Where the in-app update is. `link`: this build only links to the release page (macOS, an unpackaged build). */
export type UpdateState = 'idle' | 'checking' | 'downloading' | 'ready' | 'failed' | 'link';

/** What keeps a restart from happening now. */
export interface ApplyBlockers {
  /** Workers whose turn is not over (starting, running, or waiting for an answer). */
  workers: number;
  /** Tasks queued to start, including those waiting for a usage limit. */
  queued: number;
  /** The Dispatcher is in the middle of a turn. */
  dispatcher: boolean;
}

/** The update as the window shows it. */
export interface UpdateView {
  state: UpdateState;
  /** The newer version, when one is known. */
  version: string | null;
  /** Its release page. */
  url: string | null;
  /** Download progress, 0–100. */
  percent: number;
  /** Set while an update is ready: what a restart would wait for. */
  blockers: ApplyBlockers | null;
}

/** The release page of a version. */
export const releaseUrl = (version: string) => `https://github.com/${RELEASE_REPO}/releases/tag/v${version}`;

const BUSY_WORKER = new Set(['starting', 'running', 'waiting']);

export function applyBlockers(s: { workers: { status: string }[]; tasks: { status: string }[]; dispatcherBusy: boolean }): ApplyBlockers {
  return {
    workers: s.workers.filter((w) => BUSY_WORKER.has(w.status)).length,
    queued: s.tasks.filter((t) => t.status === 'queued').length,
    dispatcher: s.dispatcherBusy,
  };
}

/** May the app restart into the downloaded update now? Only when one is ready and nothing is working or about to start. */
export function mayApply(state: UpdateState, b: ApplyBlockers): boolean {
  return state === 'ready' && b.workers === 0 && b.queued === 0 && !b.dispatcher;
}

/**
 * A local update feed for testing a packaged build (OMA_UPDATE_FEED), as a URL ending in "/".
 * Only this computer (127.0.0.1, ::1, localhost) is accepted: anything else is ignored.
 */
export function feedOverride(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return null;
    return u.href.endsWith('/') ? u.href : `${u.href}/`;
  } catch {
    return null;
  }
}
