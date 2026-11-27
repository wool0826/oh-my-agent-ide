/** The app's one tooltip: where it sits and when it shows. Drawing and listening are in renderer/ui/tip.ts. */

export const TIP_DELAY = 500;
/** Moving from one control to the next within this long shows the next tip at once. */
export const TIP_SKIP = 300;
export const TIP_GAP = 6;
export const TIP_EDGE = 8;

export interface TipBox { left: number; top: number; width: number; height: number }

/**
 * Centred on the control and `gap` away: below when asked (the toolbar) and above elsewhere,
 * on the other side when the wanted one has no room, and always `edge` inside the window.
 */
export function tipPlace(a: TipBox, w: number, h: number, vw: number, vh: number, below: boolean, gap = TIP_GAP, edge = TIP_EDGE): { left: number; top: number; below: boolean } {
  const roomAbove = a.top - gap - h >= edge;
  const roomBelow = a.top + a.height + gap + h <= vh - edge;
  const under = below ? roomBelow || !roomAbove : !roomAbove && roomBelow;
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, Math.max(lo, hi)));
  return {
    left: Math.round(clamp(a.left + a.width / 2 - w / 2, edge, vw - edge - w)),
    top: Math.round(clamp(under ? a.top + a.height + gap : a.top - gap - h, edge, vh - edge - h)),
    below: under,
  };
}

/**
 * A card beside its row (a sidebar row's tooltip): on the right, its top level with the row's and moved up to stay in
 * the window; on the left when the right has no room; above or below the row (as tipPlace) when neither side has.
 */
export function cardPlace(a: TipBox, w: number, h: number, vw: number, vh: number, gap = TIP_GAP, edge = TIP_EDGE): { left: number; top: number; side: 'right' | 'left' | 'below' | 'above' } {
  const top = Math.round(Math.max(edge, Math.min(a.top, vh - edge - h)));
  const right = a.left + a.width + gap;
  if (right + w <= vw - edge) return { left: Math.round(right), top, side: 'right' };
  const left = a.left - gap - w;
  if (left >= edge) return { left: Math.round(left), top, side: 'left' };
  const p = tipPlace(a, w, h, vw, vh, true, gap, edge);
  return { left: p.left, top: p.top, side: p.below ? 'below' : 'above' };
}

/** How long to wait before showing: none on keyboard focus, none right after another tip, else the hover delay. */
export function tipWait(byFocus: boolean, now: number, lastHidden: number): number {
  return byFocus || now - lastHidden < TIP_SKIP ? 0 : TIP_DELAY;
}

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

/** A tip that only repeats what is already readable on the control says nothing new. */
export function tipRepeats(tip: string, visible: string): boolean {
  return flat(visible).includes(flat(tip));
}

/** Cut text in full first, then the control's own hint; nothing said twice. */
export function tipJoin(cut: string[], own: string): string {
  const out: string[] = [];
  for (const c of cut.map((x) => x.trim()).filter(Boolean)) if (!out.includes(c) && !flat(own).includes(flat(c))) out.push(c);
  if (own.trim()) out.push(own.trim());
  return out.join('\n');
}

/** "Ctrl+Alt+B" or "⌥⌘B" as aria-keyshortcuts writes it: "Control+Alt+B", "Alt+Meta+B". */
export function tipAriaKey(key: string): string {
  return key.replace(/⌘/g, 'Meta+').replace(/⌥/g, 'Alt+').replace(/⇧/g, 'Shift+').replace(/⌃/g, 'Control+').replace(/\bCtrl\b/g, 'Control');
}

/** The tip describes the control for a screen reader unless it is the control's name or its own text. */
export function tipDescribes(tip: string, name: string | null, text: string): boolean {
  const s = flat(tip);
  return !!s && s !== flat(name ?? '') && s !== flat(text);
}
