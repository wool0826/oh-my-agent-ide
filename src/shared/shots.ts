// Screenshots in a Worker's report (T-0102): the FILE: lines that name images are shown as thumbnails on the result
// card, a screen's "before" next to its "after", instead of as file links.

/** The custom scheme the window loads a reported image through: file:// is not reachable from the page. */
export const SHOT_SCHEME = 'oma-shot';

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;

export const isImagePath = (p: string) => IMAGE.test(p.trim());

export type ShotRole = 'before' | 'after';

/** One image: its path, whether it is a before or after shot, and the screen it shows (the name without that word). */
export type Shot = { path: string; role: ShotRole | null; screen: string };

const baseName = (p: string) => p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);

/** The words of a file name without its extension: "settingsBefore-dark.png" → settings, before, dark. */
function words(p: string) {
  return baseName(p).replace(/\.[^.]+$/, '').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

export function shotOf(p: string): Shot {
  const ws = words(p);
  const at = Math.max(ws.lastIndexOf('before'), ws.lastIndexOf('after'));
  if (at < 0) return { path: p, role: null, screen: ws.join('-') };
  return { path: p, role: ws[at] as ShotRole, screen: ws.filter((_, i) => i !== at).join('-') };
}

const ORDER = { before: 0, after: 1 } as const;

/**
 * A report's files split into images and the rest. Images are grouped by screen in the order the report first names
 * each screen, and within a screen the before shot comes first, then the after, then any other.
 */
export function reportShots(files: readonly string[]): { shots: Shot[]; rest: string[] } {
  const rest: string[] = [];
  const groups = new Map<string, Shot[]>();
  for (const f of new Set(files.map((x) => x.trim()).filter(Boolean))) {
    if (!isImagePath(f)) { rest.push(f); continue; }
    const s = shotOf(f);
    const key = s.role ? s.screen : `\0${f}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  const rank = (s: Shot) => (s.role ? ORDER[s.role] : 2);
  const shots = [...groups.values()].flatMap((g) => g.map((s, i) => ({ s, i })).sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i).map((x) => x.s));
  return { shots, rest };
}

/** The address the window loads an image file from. */
export const shotUrl = (p: string) => `${SHOT_SCHEME}://file/${encodeURIComponent(p)}`;

/** The image file a shot address names, or null when it is not one (another host, not an image). */
export function shotPath(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== `${SHOT_SCHEME}:` || u.host !== 'file') return null;
  let p: string;
  try { p = decodeURIComponent(u.pathname.slice(1)); } catch { return null; }
  return p && isImagePath(p) ? p : null;
}
