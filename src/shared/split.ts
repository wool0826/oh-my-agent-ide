// Two Workers side by side (item 15A): the rules for the pair of panes in the Worker view. Pure, so the renderer and
// the tests share it. The selected pane is the Worker on screen (Screen.wSel and wTab); `pair` is the other one.
import { DRAWER_BELOW } from './panelWidth';

export type WTab = 'chat' | 'changes' | 'summary';

/** The pane that is not selected: its Worker, its tab, and whether it sits on the left. */
export interface Pair { id: string; tab: WTab; left: boolean }

/** What the two panes show: the selected Worker and its tab, and the other pane when there is one. */
export interface Panes { wSel: string | null; wTab: WTab; pair: Pair | null }

/** Below this window width the right sidebar is a drawer and the view has room for one pane only. */
export const PANES_MIN = DRAWER_BELOW;

/** Whether a window this wide shows two panes. A pair kept while it is narrower shows again when it widens. */
export function panesFit(winW: number) {
  return winW >= PANES_MIN;
}

const TABS: readonly WTab[] = ['chat', 'changes', 'summary'];

/** The other pane becomes the selected one, each Worker staying on its side (F6, a click in it). */
export function swapPanes(p: Panes): Panes {
  if (!p.pair || !p.wSel) return p;
  return { wSel: p.pair.id, wTab: p.pair.tab, pair: { id: p.wSel, tab: p.wTab, left: !p.pair.left } };
}

/**
 * "Open beside" Worker `id` (Ctrl/Cmd+\, the sidebar row menu). With nothing open it simply opens. Already in a
 * pane, that pane is selected. Otherwise it opens in the other pane, on the right of a single one, and is selected;
 * the Worker that was selected stays where it was.
 */
export function openBeside(p: Panes, id: string): Panes {
  if (!p.wSel) return { wSel: id, wTab: 'chat', pair: null };
  if (id === p.wSel) return p;
  if (p.pair?.id === id) return swapPanes(p);
  return { wSel: id, wTab: 'chat', pair: { id: p.wSel, tab: p.wTab, left: p.pair ? !p.pair.left : true } };
}

/**
 * Any navigation from `from` to `to` (a sidebar row, the palette, a link, Back): a screen that would show one Worker
 * in both panes selects the pane it is in instead, the Worker that was selected moving to the other one on its side.
 * A tab asked for wins; otherwise each pane keeps its own.
 */
export function onePerPane(from: Panes, to: Panes): Panes {
  if (!to.pair || to.pair.id !== to.wSel) return to;
  if (!from.wSel || from.wSel === to.wSel) return { ...to, pair: null };
  return { wSel: to.wSel, wTab: to.wTab === from.wTab ? to.pair.tab : to.wTab, pair: { id: from.wSel, tab: from.wTab, left: !to.pair.left } };
}

/** Closes a pane: the other one (`'pair'`), or the selected one, after which the other pane is the only one. */
export function closePane(p: Panes, which: 'pair' | 'sel'): Panes {
  if (!p.pair) return p;
  if (which === 'pair') return { ...p, pair: null };
  return { wSel: p.pair.id, wTab: p.pair.tab, pair: null };
}

/**
 * Ctrl/Cmd+\ with no Worker row focused: with two panes it closes the other one; with one it opens beside it the
 * Worker that was active last among the others (`order`, most recent first), live ones before archived ones.
 * Null when there is nothing to open.
 */
export function toggleBeside(p: Panes, order: readonly { id: string; archived: boolean }[]): Panes | null {
  if (p.pair) return closePane(p, 'pair');
  const next = [...order.filter((w) => !w.archived), ...order.filter((w) => w.archived)].find((w) => w.id !== p.wSel);
  return next && p.wSel ? openBeside(p, next.id) : null;
}

/** The pair kept for the next start, as it can show now: both Workers still there and neither archived (5A). */
export function restorePair(v: unknown, wSel: string | null, there: { worker: (id: string) => boolean; archived: (id: string) => boolean }): Pair | null {
  const o = v as Partial<Record<keyof Pair, unknown>> | null;
  if (!o || typeof o.id !== 'string' || !o.id || !wSel || o.id === wSel) return null;
  if (!there.worker(o.id) || there.archived(o.id) || there.archived(wSel)) return null;
  return { id: o.id, tab: TABS.includes(o.tab as WTab) ? (o.tab as WTab) : 'chat', left: o.left === true };
}

/** A Worker that is gone leaves its pane: the pair closes, or the other pane takes the selected one's place. */
export function dropGone(p: Panes, there: (id: string) => boolean): Panes {
  if (!p.pair) return p;
  if (!there(p.pair.id)) return { ...p, pair: null };
  if (p.wSel && !there(p.wSel)) return closePane(p, 'sel');
  return p;
}
