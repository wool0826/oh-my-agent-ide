// Back and forward through the screens the user visited, like a browser (decision 81).
// Pure, so the renderer and the tests share it.

export type View = 'chat' | 'worker' | 'repo' | 'memory';
/** The Worker list shows only Workers that finished a task today, or only archived ones. */
export type WorkerFilter = 'today' | 'archived';

/** What the window shows: the view tab and what is open in it. */
export interface Screen {
  view: View;
  /** Selected Worker (inspector), and whether its conversation is open. */
  wSel: string | null;
  wOpen: boolean;
  wTab: 'chat' | 'changes' | 'summary';
  repoSel: string | null;
  memSel: string | null;
  wFilter: WorkerFilter | null;
}

/** Entries kept on each side. */
export const HISTORY_MAX = 50;

export function sameScreen(a: Screen, b: Screen) {
  return a.view === b.view && a.wSel === b.wSel && a.wOpen === b.wOpen && a.wTab === b.wTab
    && a.repoSel === b.repoSel && a.memSel === b.memSel && a.wFilter === b.wFilter;
}

const VIEWS: readonly View[] = ['chat', 'worker', 'repo', 'memory'];
const TABS: readonly Screen['wTab'][] = ['chat', 'changes', 'summary'];
const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

/**
 * The screen the last run ended on (5A), as it can be shown now, or null when nothing usable was kept. A Worker that
 * is gone is deselected with its conversation; an archived one is still there and opens as it was. A removed
 * repository is deselected.
 */
export function restoreScreen(v: unknown, there: { worker: (id: string) => boolean; repo: (name: string) => boolean }): Screen | null {
  const o = v as Partial<Record<keyof Screen, unknown>> | null;
  if (!o || !VIEWS.includes(o.view as View)) return null;
  const wSel = str(o.wSel);
  const repoSel = str(o.repoSel);
  const s: Screen = {
    view: o.view as View,
    wSel: wSel && there.worker(wSel) ? wSel : null,
    wOpen: o.wOpen === true,
    wTab: TABS.includes(o.wTab as Screen['wTab']) ? (o.wTab as Screen['wTab']) : 'chat',
    repoSel: repoSel && there.repo(repoSel) ? repoSel : null,
    memSel: str(o.memSel),
    wFilter: o.wFilter === 'today' || o.wFilter === 'archived' ? o.wFilter : null,
  };
  if (!s.wSel) s.wOpen = false;
  return s;
}

/**
 * Turns a saved entry into what can be shown now, or null to drop it (for example a conversation
 * whose Worker is gone).
 */
export type Check<T> = (entry: T) => T | null;

export class History<T> {
  readonly back: T[] = [];
  readonly forward: T[] = [];

  constructor(private readonly same: (a: T, b: T) => boolean, private readonly max = HISTORY_MAX) {}

  /**
   * A new navigation from `cur` to `next`. `cur` goes on the back stack unless it is the entry already
   * on top, and the forward entries are dropped. Moving to the screen already shown records nothing.
   */
  push(cur: T, next: T): boolean {
    if (this.same(cur, next)) return false;
    const top = this.back[this.back.length - 1];
    if (top === undefined || !this.same(top, cur)) this.back.push(cur);
    this.trim(this.back);
    this.forward.length = 0;
    return true;
  }

  /** The screen to show for Back from `cur`, or null when there is none. `cur` becomes the first Forward entry. */
  goBack(cur: T, check: Check<T> = (x) => x): T | null {
    return this.step(this.back, this.forward, cur, check);
  }

  goForward(cur: T, check: Check<T> = (x) => x): T | null {
    return this.step(this.forward, this.back, cur, check);
  }

  private step(from: T[], to: T[], cur: T, check: Check<T>): T | null {
    while (from.length) {
      const next = check(from.pop()!);
      // A stale entry, or one that now looks like the current screen, would make the key do nothing.
      if (next === null || this.same(next, cur)) continue;
      to.push(cur);
      this.trim(to);
      return next;
    }
    return null;
  }

  private trim(list: T[]) {
    if (list.length > this.max) list.splice(0, list.length - this.max);
  }
}

/** Where a Back or Forward came from: a mouse button in the page, the OS (an app command), or a shortcut. */
export type NavSource = 'mouse' | 'os' | 'key';
export type NavDir = 'back' | 'forward';

/** How long after one input a step in the same direction from another input counts as the same press. */
export const ECHO_MS = 300;

/**
 * One press of a mouse side button can arrive twice: Windows sends it to the page as a mouse event and,
 * through the default window procedure, as a `browser-backward` app command (Linux does the same). The
 * first one counts; the same step from another source right after it is its echo. Repeats from the
 * source that counted go through, so a fast double click still steps twice.
 */
export class NavInput {
  private last: { src: NavSource; dir: NavDir; at: number } | null = null;

  accept(src: NavSource, dir: NavDir, now: number): boolean {
    const l = this.last;
    if (l && l.src !== src && l.dir === dir && now - l.at < ECHO_MS) return false;
    this.last = { src, dir, at: now };
    return true;
  }
}
