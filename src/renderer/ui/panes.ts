// The right sidebar's lists: one column at any width. Every item that can be selected is a slot (.pk) holding its
// card (.pk-c); the selected card opens in place. Only the "New automation" and "New script" slots also have a row
// (.li), which stands for their form while it is closed.
//
// Every list is one Tab stop (roving tabindex): its items carry data-nav, a key that names the item, and ↑/↓ move
// between the ones shown. Selecting is the user's doing only (a click, Enter or Space, ↑/↓); the focus alone selects
// nothing.
import { $, esc } from './core';

export type PaneTab = 'inbox' | 'memo' | 'auto' | 'script';

/** One selectable item: its card, after `row` when it has one. `cls` marks a kind of slot (" new"). */
export function slotHtml(key: string, sel: boolean, card: string, row = '', cls = '') {
  return `<div class="pk${cls}${sel ? ' sel' : ''}" data-pick="${esc(key)}">${row}<div class="pk-c">${card}</div></div>`;
}

/** A list row. Which item of the list is its one Tab stop is set by rove(). */
export function rowHtml(tab: PaneTab, key: string, sel: boolean, inner: string) {
  return `<div class="li" role="button" data-action="pick" data-tab="${tab}" data-id="${esc(key)}" data-nav="${tab}:${esc(key)}" data-focus="pick-${tab}-${esc(key)}" tabindex="-1"${sel ? ' aria-current="true"' : ''}>${inner}</div>`;
}

/** The items of the list shown now, in order. */
export function navItems(root: HTMLElement = $('#chat-ins')): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('.ins-list [data-nav]')].filter((x) => !!x.offsetParent);
}

/** The list item `el` stands for: itself or the one it is inside. */
export function navItem(el: Element | null, root: HTMLElement = $('#chat-ins')): HTMLElement | null {
  if (!el || !root.contains(el)) return null;
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

/** The tab's content scrolls in its own box under the tabs, so the tabs stay in view (data-scroll keeps its offset). */
export const colsHtml = (list: string, attrs = '') => `<div class="ins-body" data-scroll="ins-body"${attrs}><div class="ins-cols"><div class="ins-list">${list}</div></div></div>`;

/** Selects slot `key` in place (slots and their rows), then makes the list's Tab stop follow. */
export function markPick(key: string | null, root: HTMLElement = $('#chat-ins')) {
  root.querySelectorAll<HTMLElement>('.ins-list .pk').forEach((slot) => {
    const on = slot.dataset.pick === key;
    slot.classList.toggle('sel', on);
    const row = slot.querySelector<HTMLElement>(':scope > .li');
    if (!row) return;
    if (on) row.setAttribute('aria-current', 'true'); else row.removeAttribute('aria-current');
  });
  rove(root);
}
