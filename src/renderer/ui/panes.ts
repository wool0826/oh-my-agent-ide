// The right sidebar's list and detail (shared/insPanes). Every item that can be selected is a slot (.pk) holding
// its list row (.li) and its card (.pk-c). From SPLIT_AT wide the selected slot's card moves into the detail pane;
// under it the card goes back to its slot. The node moves and is not drawn again, so typed text, the caret and the
// focus stay where they were.
//
// Every list is one Tab stop (roving tabindex): its items carry data-nav, a key that names the item whatever its
// form (the row in two panes, the card in one column), and ↑/↓ move between the ones shown at any width.
// Selecting is the user's doing only (a click, Enter or Space, ↑/↓); the focus alone selects nothing.
import { paneMode } from '../../shared/insPanes';
import { $, esc } from './core';

export type PaneTab = 'inbox' | 'memo' | 'auto' | 'script';

/** One selectable item: its row for the list column, then its card. `cls` marks a kind of slot (" new"). */
export function slotHtml(key: string, sel: boolean, row: string, card: string, cls = '') {
  return `<div class="pk${cls}${sel ? ' sel' : ''}" data-pick="${esc(key)}">${row}<div class="pk-c">${card}</div></div>`;
}

/** A list row. Which item of the list is its one Tab stop is set by rove(). */
export function rowHtml(tab: PaneTab, key: string, sel: boolean, inner: string) {
  return `<div class="li" role="button" data-action="pick" data-tab="${tab}" data-id="${esc(key)}" data-nav="${tab}:${esc(key)}" data-focus="pick-${tab}-${esc(key)}" tabindex="-1"${sel ? ' aria-current="true"' : ''}>${inner}</div>`;
}

/** The items of the list shown now, in order: rows in two panes, cards in one column; never the detail pane. */
export function navItems(root: HTMLElement = $('#chat-ins')): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('.ins-list [data-nav]')].filter((x) => !!x.offsetParent && !x.closest('.ins-detail'));
}

/** The list item `el` stands for: itself, the one it is inside, or the selected row for the card in the detail pane. */
export function navItem(el: Element | null, root: HTMLElement = $('#chat-ins')): HTMLElement | null {
  if (!el || !root.contains(el)) return null;
  if (el.closest('.ins-detail')) return root.querySelector<HTMLElement>('.ins-list .pk.sel > .li');
  return el.closest<HTMLElement>('.ins-list [data-nav]');
}

/** The key of the item last focused in the list, so Tab comes back to it when nothing is selected. */
let lastNav: string | null = null;
export const noteNav = (key: string | null) => { lastNav = key; };

const isSel = (x: HTMLElement) => x.classList.contains('sel') || x.getAttribute('aria-current') === 'true' || !!x.closest('.pk.sel');

/** What a control inside an item that is not the stop is taken out of Tab with, and put back from. */
const INNER = 'button, a[tabindex], input, textarea, select, [tabindex]';

/**
 * Makes the list one Tab stop: the item with the focus, else the selected one, else the one focused last, else the
 * first. The controls of the other items leave the Tab order too (they still take a click).
 */
export function rove(root: HTMLElement = $('#chat-ins')) {
  const shown = navItems(root);
  const a = document.activeElement;
  const stop = shown.find((x) => x === a || x.contains(a)) ?? shown.find(isSel) ?? shown.find((x) => x.dataset.nav === lastNav) ?? shown[0] ?? null;
  root.querySelectorAll<HTMLElement>('.ins-list [data-nav]').forEach((x) => {
    const on = x === stop;
    if (x.tabIndex !== (on ? 0 : -1)) x.tabIndex = on ? 0 : -1;
    x.querySelectorAll<HTMLElement>(INNER).forEach((c) => {
      if (c.closest('[data-nav]') !== x) return;
      if (!on && c.dataset.rove === undefined) { c.dataset.rove = c.getAttribute('tabindex') ?? ''; c.tabIndex = -1; }
      else if (on && c.dataset.rove !== undefined) {
        if (c.dataset.rove) c.setAttribute('tabindex', c.dataset.rove); else c.removeAttribute('tabindex');
        delete c.dataset.rove;
      }
    });
  });
}

/** A row's text: the title on up to two lines, and one small line under it. */
export const rowText = (title: string, small: string) => `<span class="t"><b>${esc(title)}</b>${small ? `<small>${esc(small)}</small>` : ''}</span>`;

/** The tab's content scrolls in its own box under the tabs, so the tabs stay in view (data-scroll keeps its offset). */
export const colsHtml = (list: string, attrs = '') => `<div class="ins-body" data-scroll="ins-body"${attrs}><div class="ins-cols"><div class="ins-list">${list}</div><div class="ins-detail"></div></div></div>`;

/** The sidebar's width as the user set it; the aside itself is narrower by its inset. */
function sidebarWidth(root: HTMLElement) {
  const w = parseFloat($('#win').style.getPropertyValue('--inspector-w'));
  return Number.isFinite(w) ? w : root.offsetWidth;
}


/** Moves `node` into `to`, keeping a focus inside it, with the caret and the scroll of a text field. */
function moveKeep(node: HTMLElement, to: HTMLElement) {
  const a = document.activeElement as HTMLElement | null;
  const inside = !!a && node.contains(a);
  const field = inside && (a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement) ? a : null;
  const range = field ? { s: field.selectionStart, e: field.selectionEnd, d: field.selectionDirection ?? undefined, top: field.scrollTop } : null;
  to.append(node);
  if (!inside) return;
  a!.focus({ preventScroll: true });
  if (field && range && range.s != null && range.e != null) {
    try { field.setSelectionRange(range.s, range.e, range.d); } catch { /* not selectable */ }
    field.scrollTop = range.top;
  }
}

/** Puts the selected card where the width wants it: in the detail pane from SPLIT_AT, in its slot under it. */
export function placeDetail(root: HTMLElement = $('#chat-ins')) {
  const cols = root.querySelector<HTMLElement>(':scope > .ins-body > .ins-cols');
  if (!cols) return;
  const detail = cols.querySelector<HTMLElement>(':scope > .ins-detail')!;
  const sel = cols.querySelector<HTMLElement>(':scope > .ins-list .pk.sel');
  const split = paneMode(sidebarWidth(root), !!sel) === 'split';
  if (cols.classList.contains('split') !== split) cols.classList.toggle('split', split);
  const cur = detail.querySelector<HTMLElement>(':scope > .pk-c');
  const want = split && sel ? sel.querySelector<HTMLElement>(':scope > .pk-c') ?? (cur?.dataset.from === sel.dataset.pick ? cur : null) : null;
  if (cur && cur !== want) {
    const home = cols.querySelector<HTMLElement>(`.ins-list .pk[data-pick="${CSS.escape(cur.dataset.from ?? '')}"]`);
    if (home) moveKeep(cur, home); else cur.remove();
  }
  if (want && want.parentElement !== detail) {
    want.dataset.from = sel!.dataset.pick;
    moveKeep(want, detail);
  }
  rove(root);
}

/** Selects slot `key` in place (rows and slots), then places its card. */
export function markPick(key: string | null, root: HTMLElement = $('#chat-ins')) {
  root.querySelectorAll<HTMLElement>('.ins-list .pk').forEach((slot) => {
    const on = slot.dataset.pick === key;
    slot.classList.toggle('sel', on);
    const row = slot.querySelector<HTMLElement>(':scope > .li');
    if (!row) return;
    if (on) row.setAttribute('aria-current', 'true'); else row.removeAttribute('aria-current');
  });
  placeDetail(root);
}

/** Follows the sidebar's width: crossing SPLIT_AT while dragging moves the selected card, nothing else. */
export function watchPanes() {
  const root = $('#chat-ins');
  new ResizeObserver(() => placeDetail(root)).observe(root);
}
