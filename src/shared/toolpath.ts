// The PATH external tools (gh, git, codex, claude) are run with.
// An app opened from Finder, the Dock or Launchpad on macOS gets launchd's short PATH (/usr/bin:/bin:/usr/sbin:/sbin),
// not the one the user's shell builds, so Homebrew, MacPorts and Nix tools are not found without this.

/** Folders package managers install command-line tools into, on macOS and Linux. */
export function commonToolDirs(home: string): string[] {
  const h = home.replace(/\/+$/, '');
  return [
    '/opt/homebrew/bin', '/opt/homebrew/sbin', // Homebrew on Apple silicon
    '/usr/local/bin', '/usr/local/sbin', // Homebrew on Intel, most manual installs
    '/opt/local/bin', // MacPorts
    '/home/linuxbrew/.linuxbrew/bin', // Homebrew on Linux
    '/snap/bin',
    ...(h ? [`${h}/.nix-profile/bin`, `${h}/.local/bin`, `${h}/bin`] : []),
    '/nix/var/nix/profiles/default/bin',
    '/usr/bin', '/bin', '/usr/sbin', '/sbin',
  ];
}

/**
 * The PATH to run tools with: the app's own PATH first, then the login shell's, then the common folders,
 * each folder once in first-seen order. On Windows the PATH is returned unchanged.
 */
export function augmentedPath(o: { platform: string; current: string | undefined; shellPath?: string | null; home: string }): string {
  const current = o.current ?? '';
  if (o.platform === 'win32') return current;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of [...current.split(':'), ...(o.shellPath ?? '').split(':'), ...commonToolDirs(o.home)]) {
    const dir = part.trim();
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    out.push(dir);
  }
  return out.join(':');
}

/** Printed before the PATH, so lines a shell's startup files print first are skipped. */
export const PATH_MARKER = '__OMA_PATH__=';

/** The PATH a login shell printed after PATH_MARKER, or null when it printed none. */
export function parseShellPath(stdout: string): string | null {
  const at = stdout.lastIndexOf(PATH_MARKER);
  if (at < 0) return null;
  const path = stdout.slice(at + PATH_MARKER.length).split(/\r?\n/)[0].trim();
  return path.includes('/') ? path : null;
}

/** Where a GUI app's missing tools usually are, looked at before the PATH. */
export const PREFERRED_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin'];

/**
 * The absolute path of `name`: the preferred folders first, then each PATH folder in order. Null when none has it.
 * A name with a slash is a path already. On Windows nothing is resolved (execFile finds .exe files itself).
 */
export function findTool(name: string, o: { platform: string; path: string; exists: (file: string) => boolean }): string | null {
  if (o.platform === 'win32' || name.includes('/')) return null;
  const seen = new Set<string>();
  for (const dir of [...PREFERRED_DIRS, ...o.path.split(':')]) {
    const d = dir.trim().replace(/\/+$/, '');
    if (!d || seen.has(d)) continue;
    seen.add(d);
    if (o.exists(`${d}/${name}`)) return `${d}/${name}`;
  }
  return null;
}

/** What a tool that could not be started (ENOENT, e.g. "spawn gh ENOENT") is reported as, instead of the raw error. */
export function notFoundMessage(name: string, searched: string): string {
  const how = name === 'gh' ? ' Install the GitHub CLI (macOS: brew install gh, Windows: winget install --id GitHub.cli -e, or cli.github.com), then run gh auth login.' : ` Install ${name} and try again.`;
  return `${name} not found. Searched: ${PREFERRED_DIRS.join(':')}:${searched}.${how}`;
}
