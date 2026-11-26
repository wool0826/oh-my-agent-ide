// Screenshots in a Worker's report (T-0102): the FILE: lines that name images are shown as thumbnails on the result
// card, a screen's "before" next to its "after", instead of as file links. Its other parts (wide/narrow, dark/light)
// are switches, so a screen shows one pair at a time (decision 229).

/** The custom scheme the window loads a reported image through: file:// is not reachable from the page. */
export const SHOT_SCHEME = 'oma-shot';

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;

export const isImagePath = (p: string) => IMAGE.test(p.trim());

/**
 * A path on this computer's own disks, from its root: a drive letter on Windows or a single leading slash. A network
 * path (\\host\share, //host) would make the window open a connection and is never one; nor is a path with a ".." step.
 */
export function isLocalPath(p: string) {
  if (!/^[A-Za-z]:[\\/]/.test(p) && !/^\/(?!\/)/.test(p)) return false;
  return !p.split(/[\\/]/).includes('..');
}

export type ShotRole = 'before' | 'after';

/** The other parts a screenshot's name can vary by, each with its words in the order they are shown (decision 229). */
export const SHOT_AXES = { width: ['wide', 'narrow'], theme: ['dark', 'light'] } as const;

export type ShotAxis = keyof typeof SHOT_AXES;

/**
 * One image: its path, whether it is a before or after shot, the width and theme its name gives, and the screen it
 * shows (the name without those words).
 */
export type Shot = { path: string; role: ShotRole | null; screen: string } & Record<ShotAxis, string | null>;

const AXIS_NAMES = Object.keys(SHOT_AXES) as ShotAxis[];

const baseName = (p: string) => p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);

/** The words of a file name without its extension: "settingsBefore-dark.png" → settings, before, dark. */
function words(p: string) {
  return baseName(p).replace(/\.[^.]+$/, '').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

export function shotOf(p: string): Shot {
  const ws = words(p);
  const at = Math.max(ws.lastIndexOf('before'), ws.lastIndexOf('after'));
  const used = new Set(at < 0 ? [] : [at]);
  const axis = {} as Record<ShotAxis, string | null>;
  for (const a of AXIS_NAMES) {
    const i = Math.max(...SHOT_AXES[a].map((w) => ws.lastIndexOf(w)));
    axis[a] = i < 0 ? null : ws[i];
    if (i >= 0) used.add(i);
  }
  return { path: p, role: at < 0 ? null : (ws[at] as ShotRole), screen: ws.filter((_, i) => !used.has(i)).join('-'), ...axis };
}

/**
 * The shots of one screen. `roles`: the before/after columns it has, in that order. `axes`: the parts it varies by
 * that need a switch (two values or more), each with its values in order.
 */
export type ShotSet = { screen: string; shots: Shot[]; roles: ShotRole[]; axes: Partial<Record<ShotAxis, string[]>> };

const ROLE_ORDER = { before: 0, after: 1 } as const;
const rank = (s: Shot) => (s.role ? ROLE_ORDER[s.role] : 2);
const axisRank = (a: ShotAxis, v: string | null) => (v === null ? -1 : (SHOT_AXES[a] as readonly string[]).indexOf(v));

/**
 * A report's files split into images, grouped by screen, and the rest (decision 229). A screen's shots are the images
 * whose names differ only by before/after, wide/narrow and dark/light; an image with none of those words is a screen
 * of its own. Screens keep the order the report first names them; within one, before comes ahead of after, then wide
 * ahead of narrow and dark ahead of light.
 */
export function shotSets(files: readonly string[]): { sets: ShotSet[]; rest: string[] } {
  const rest: string[] = [];
  const groups = new Map<string, Shot[]>();
  for (const f of new Set(files.map((x) => x.trim()).filter(Boolean))) {
    // A relative or network path cannot be shown: it stays a file link.
    if (!isImagePath(f) || !isLocalPath(f)) { rest.push(f); continue; }
    const s = shotOf(f);
    const tagged = s.role || AXIS_NAMES.some((a) => s[a]);
    const key = tagged ? s.screen : `\0${f}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  const sets = [...groups.values()].map((g): ShotSet => {
    const shots = g.map((s, i) => ({ s, i }))
      .sort((a, b) => rank(a.s) - rank(b.s) || AXIS_NAMES.reduce((d, x) => d || axisRank(x, a.s[x]) - axisRank(x, b.s[x]), 0) || a.i - b.i)
      .map((x) => x.s);
    const roles = (['before', 'after'] as const).filter((r) => shots.some((s) => s.role === r));
    const axes: ShotSet['axes'] = {};
    for (const a of AXIS_NAMES) {
      const vs = SHOT_AXES[a].filter((v) => shots.some((s) => s[a] === v));
      if (vs.length > 1) axes[a] = vs;
    }
    return { screen: shots[0].screen, shots, roles, axes };
  });
  return { sets, rest };
}

export type ShotPick = Partial<Record<ShotAxis, string>>;

/** What a set shows before its switches are touched: the first value of each part it varies by. */
export function firstPick(set: ShotSet): ShotPick {
  const out: ShotPick = {};
  for (const a of AXIS_NAMES) if (set.axes[a]) out[a] = set.axes[a]![0];
  return out;
}

/**
 * The shot of a set for one column (its role) under the switches: the one that matches the most switches, a name
 * without that part counting as half a match. Null when the set has no shot in that column.
 */
export function pickShot(set: ShotSet, role: ShotRole | null, pick: ShotPick): Shot | null {
  let best: Shot | null = null, top = -1;
  for (const s of set.shots) {
    if (s.role !== role) continue;
    const score = AXIS_NAMES.reduce((n, a) => n + (!pick[a] ? 0 : s[a] === pick[a] ? 2 : s[a] === null ? 1 : 0), 0);
    if (score > top) { best = s; top = score; }
  }
  return best;
}

/**
 * What a set shows on a card: a column per role (one column when it has none), each with its shot under the switches,
 * and how many of its images that leaves out of sight.
 */
export function setView(set: ShotSet, pick: ShotPick) {
  const roles: (ShotRole | null)[] = set.roles.length ? [...set.roles] : [null];
  // A shot without a role in a set with roles (card-dark.png beside card-before-dark.png) gets a column of its own.
  if (set.roles.length && set.shots.some((s) => !s.role)) roles.push(null);
  const cols = roles.map((role) => ({ role, shot: pickShot(set, role, pick) }));
  return { cols, hidden: set.shots.length - cols.filter((c) => c.shot).length };
}

/** The address the window loads an image file from. */
export const shotUrl = (p: string) => `${SHOT_SCHEME}://file/${encodeURIComponent(p)}`;

/** The image file a shot address names, or null when it is not one (another host, not an image, not a local path). */
export function shotPath(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== `${SHOT_SCHEME}:` || u.host !== 'file') return null;
  let p: string;
  try { p = decodeURIComponent(u.pathname.slice(1)); } catch { return null; }
  return p && isImagePath(p) && isLocalPath(p) ? p : null;
}
