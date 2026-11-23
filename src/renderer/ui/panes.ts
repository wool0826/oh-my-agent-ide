// The right sidebar's list and detail (shared/insPanes). Every item that can be selected is a slot (.pk) holding
// its list row (.li) and its card (.pk-c). From SPLIT_AT wide the selected slot's card moves into the detail pane;
// under it the card goes back to its slot. The node moves and is not drawn again, so typed text, the caret and the
// focus stay where they were.
import { paneMode } from '../../shared/insPanes';
import { $, esc } from './core';

export type PaneTab = 'inbox' | 'memo' | 'auto';

/** One selectable item: its row for the list column, then its card. `cls` marks a kind of slot (" new"). */
export function slotHtml(key: string, sel: boolean, row: string, card: string, cls = '') {
  return `<div class="pk${cls}${sel ? ' sel' : ''}" data-pick="${esc(key)}">${row}<div class="pk-c">${card}</div></div>`;
}

/** A list row; the selected one is the list's one stop for Tab. */
export function rowHtml(tab: PaneTab, key: string, sel: boolean, inner: string) {
  return `<div class="li" role="button" data-action="pick" data-tab="${tab}" data-id="${esc(key)}" data-focus="pick-${tab}-${esc(key)}" tabindex="${sel ? 0 : -1}"${sel ? ' aria-current="true"' : ''}>${inner}</div>`;
}

/** A row's text: the title on up to two lines, and one small line under it. */
export const rowText = (title: string, small: string) => `<span class="t"><b>${esc(title)}</b>${small ? `<small>${esc(small)}</small>` : ''}</span>`;

export const colsHtml = (list: string) => `<div class="ins-cols"><div class="ins-list">${list}</div><div class="ins-detail"></div></div>`;

/** The sidebar's width as the user set it; the aside itself is narrower by its inset. */
function sidebarWidth(root: HTMLElement) {
  const w = parseFloat($('#win').style.getPropertyValue('--inspector-w'));
  return Number.isFinite(w) ? w : root.offsetWidth;
}

/** True while a card is being moved: the focus it gets back is not the user selecting it (app.ts, focusin). */
let placing = false;
export const isPlacing = () => placing;

/** Moves `node` into `to`, keeping a focus inside it, with the caret and the scroll of a text field. */
function moveKeep(node: HTMLElement, to: HTMLElement) {
  const a = document.activeElement as HTMLElement | null;
  const inside = !!a && node.contains(a);
  const field = inside && (a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement) ? a : null;
  const range = field ? { s: field.selectionStart, e: field.selectionEnd, d: field.selectionDirection ?? undefined, top: field.scrollTop } : null;
  to.append(node);
  if (!inside) return;
  placing = true;
  try { a!.focus({ preventScroll: true }); } finally { placing = false; }
  if (field && range && range.s != null && range.e != null) {
    try { field.setSelectionRange(range.s, range.e, range.d); } catch { /* not selectable */ }
    field.scrollTop = range.top;
  }
}

/** Puts the selected card where the width wants it: in the detail pane from SPLIT_AT, in its slot under it. */
export function placeDetail(root: HTMLElement = $('#chat-ins')) {
  const cols = root.querySelector<HTMLElement>(':scope > .ins-cols');
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
}

/** Selects slot `key` in place (rows and slots), then places its card. */
export function markPick(key: string | null, root: HTMLElement = $('#chat-ins')) {
  root.querySelectorAll<HTMLElement>('.ins-list .pk').forEach((slot) => {
    const on = slot.dataset.pick === key;
    slot.classList.toggle('sel', on);
    const row = slot.querySelector<HTMLElement>(':scope > .li');
    if (!row) return;
    row.tabIndex = on ? 0 : -1;
    if (on) row.setAttribute('aria-current', 'true'); else row.removeAttribute('aria-current');
  });
  placeDetail(root);
}

/** ↑/↓ on a list row: the row `step` away, among the ones shown. */
export function nextRow(row: HTMLElement, step: number): HTMLElement | null {
  const rows = [...(row.closest('.ins-list')?.querySelectorAll<HTMLElement>('.pk > .li') ?? [])].filter((r) => r.offsetParent);
  const i = rows.indexOf(row);
  return i < 0 ? null : rows[Math.min(rows.length - 1, Math.max(0, i + step))] ?? null;
}

/** Follows the sidebar's width: crossing SPLIT_AT while dragging moves the selected card, nothing else. */
export function watchPanes() {
  const root = $('#chat-ins');
  new ResizeObserver(() => placeDetail(root)).observe(root);
}
