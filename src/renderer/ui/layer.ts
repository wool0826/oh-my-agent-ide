/**
 * The focus follows a layer (Settings, the palette, a dialog): where it was is remembered when the layer opens,
 * and it goes back there when the layer closes.
 */
import { focusSelector } from '../../shared/focusKey';

interface Back { el: HTMLElement; sel: string | null }

const backs = new Map<string, Back | null>();

/** The layer `name` is about to open. A second call while it is open (a redraw) changes nothing. */
export function layerOpen(name: string) {
  if (backs.has(name)) return;
  const el = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
  backs.set(name, el ? { el, sel: focusSelector(el.tagName, el.dataset) } : null);
}

const shown = (x: HTMLElement) => x.isConnected && !!x.getClientRects().length;

/**
 * The layer `name` is gone. The focus returns to where it was; after a redraw, to the control that took that
 * place; and when that is gone too, to the composer on screen rather than nowhere.
 */
export function layerClose(name: string, restore = true) {
  if (!backs.has(name)) return;
  const b = backs.get(name);
  backs.delete(name);
  if (!restore || !b) return;
  const again = b.sel ? [...document.querySelectorAll<HTMLElement>(b.sel)].find(shown) : null;
  const composer = [...document.querySelectorAll<HTMLElement>('#chat-input, #ws-input')].find(shown);
  (shown(b.el) ? b.el : again ?? composer)?.focus({ preventScroll: true });
}

/** Moves the focus into a layer that has just been drawn, unless it is in there already. */
export function layerFocus(root: HTMLElement, first: HTMLElement | null | undefined) {
  if (root.contains(document.activeElement) && document.activeElement !== root) return;
  first?.focus({ preventScroll: true });
}
