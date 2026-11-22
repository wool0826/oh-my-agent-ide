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
