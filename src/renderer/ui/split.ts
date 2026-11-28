// Two Workers side by side (item 15A). The selected pane is the Worker view as it always was (#wk-session, the
// Worker in ui.wSel, its composer, keys and right sidebar); the pane beside it (#wk-pair) draws the other Worker of
// ui.pair from the same parts. A click in that pane, or F6, selects it: the two swap roles and each stays on its side.
import { closePane, dropGone, openBeside, panesFit, swapPanes, toggleBeside, type Panes, type WTab } from '../../shared/split';
import { PAGE } from '../../shared/paging';
import type { LogPage, Worker } from '../../shared/types';
import { draftOf } from '../app';
import { $, call, esc, isMac, lang, modelLabel, S, setThread, t, toast, ui, worker, workerTask } from './core';
import { go, screen, show } from './history';
import { openSplitHtml } from './openWith';
import { logHtml, renderDiff, renderSession, renderSummary, wTabLabel, wTabsOf } from './workers';

/** "Open beside" as the menus and the key list show it. */
export const besideKey = () => (isMac ? '⌘ \\' : 'Ctrl \\');

const svg = (id: string) => `<svg aria-hidden="true"><use href="#${id}"/></svg>`;

/** Whether two panes are on screen now: a pair kept while the window is narrow waits for it to widen. */
export function panesShown() {
  return ui.view === 'worker' && ui.wOpen && !!ui.pair && !!worker(ui.wSel) && !!worker(ui.pair.id) && panesFit(innerWidth);
}

const panesNow = (): Panes => ({ wSel: ui.wSel, wTab: ui.wTab, pair: ui.pair });

/**
 * Puts the panes on screen. Opening or closing one is a navigation that Back undoes; selecting the other pane is
 * not, as moving the focus between two editors is not.
 */
function apply(p: Panes, navigate: boolean) {
  const next = { view: 'worker' as const, wOpen: !!p.wSel, wSel: p.wSel, wTab: p.wTab, pair: p.pair };
  if (navigate) { go(next); return; }
  const from = screen();
  show({ ...from, ...next }, from);
}

/** The pane's body for a tab: its conversation, its changes or its summary. */
const bodyOf = (pane: 'ws' | 'wp', tab: WTab) => $(`#${pane}-${tab === 'chat' ? 'thread' : tab === 'changes' ? 'diff' : 'sum'}`);
/** Where a body is scrolled: a conversation from its end, the others from the top. */
function placeOf(el: HTMLElement, tab: WTab) {
  return tab === 'chat' ? el.scrollHeight - el.scrollTop : el.scrollTop;
}
function placeAt(el: HTMLElement, tab: WTab, at: number) {
  el.scrollTop = tab === 'chat' ? el.scrollHeight - at : at;
}

/**
 * The other pane becomes the selected one (a click in it, F6). Each body keeps where it was scrolled, and with
 * `focus` the keyboard goes to the composer of the pane now selected.
 */
export function selectOther(focus = false, tab: WTab | null = null) {
  if (!panesShown() || !ui.pair) return;
  const was = panesNow();
  const keep = { live: placeOf(bodyOf('ws', was.wTab), was.wTab), pair: placeOf(bodyOf('wp', ui.pair.tab), ui.pair.tab) };
  const next = swapPanes(was);
  const moved = tab && tab !== next.wTab;
  if (tab) next.wTab = tab;
  apply(next, false);
  if (!moved) placeAt(bodyOf('ws', next.wTab), next.wTab, keep.pair);
  if (ui.pair) placeAt(bodyOf('wp', ui.pair.tab), ui.pair.tab, keep.live);
  if (focus) $<HTMLTextAreaElement>('#ws-input').focus({ preventScroll: true });
}

/** Opens Worker `id` beside the one on screen (Ctrl/Cmd+\, the row menu), or says the window is too narrow. */
export function openBesideOf(id: string) {
  if (!worker(id)) return;
  if (!panesFit(innerWidth)) { toast(t('pane.narrow'), false, undefined, 'err'); return; }
  const cur = ui.view === 'worker' && ui.wOpen ? panesNow() : { wSel: ui.wSel, wTab: ui.wTab, pair: null };
  apply(openBeside(worker(cur.wSel) ? cur : { ...cur, wSel: null }, id), true);
}

/**
 * Ctrl/Cmd+\ with no Worker row focused: the other pane closes, or the Worker active last among the others opens
 * beside the one on screen.
 */
export function toggleBesideKey() {
  if (!S) return;
  if (!panesFit(innerWidth)) { toast(t('pane.narrow'), false, undefined, 'err'); return; }
  if (ui.view !== 'worker' || !ui.wOpen || !worker(ui.wSel)) return;
  const order = S.workers.slice().sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt)).map((w) => ({ id: w.id, archived: w.status === 'archived' }));
  const next = toggleBeside(panesNow(), order);
  if (next) apply(next, true);
}

export function closePaneOf(which: 'pair' | 'sel') {
  apply(closePane(panesNow(), which), true);
}

/** F6 and Shift+F6: the other pane, with the keyboard in its composer. False when there is only one pane. */
export function paneKey() {
  if (!panesShown()) return false;
  selectOther(true);
  return true;
}

/** A Worker that is gone leaves its pane. */
export function keepPanes() {
  if (!ui.pair || !S) return;
  const p = dropGone(panesNow(), (id) => !!worker(id));
  if (p.pair !== ui.pair || p.wSel !== ui.wSel) Object.assign(ui, { pair: p.pair, wSel: p.wSel, wTab: p.wTab });
}

const loading = new Set<string>();
/** The other pane's Worker's conversation, when it was never loaded: its last page, as the selected pane loads it. */
async function loadPairLog(id: string) {
  if (loading.has(id)) return;
  loading.add(id);
  const r = await call<LogPage>('worker:log', id, { limit: PAGE.log });
  loading.delete(id);
  if (r && !ui.logs.has(id)) { ui.logs.set(id, r.items); ui.logFrom.set(id, r.start); }
  if (ui.pair?.id === id) renderPair(true);
}

/** Links and buttons in the other pane's body are not Tab stops: the pane is reached with F6 or a click. */
function noTabStops(el: HTMLElement) {
  el.querySelectorAll<HTMLElement>('a, button, input, textarea, select, summary, [tabindex]').forEach((x) => { x.tabIndex = -1; });
}

let drawn = { head: '', log: '', body: '' };

function headHtml(w: Worker, tab: WTab) {
  const x = workerTask(w);
  const sub = [w.repo ?? t('general'), x?.branch, modelLabel(w.model)].filter(Boolean).join(' · ');
  const tabs = wTabsOf(w).map((v) => `<button type="button" role="tab" aria-selected="${tab === v}" tabindex="-1" data-action="pane-tab" data-v="${v}">${wTabLabel(v, true)}</button>`).join('');
  const more = t('export.menu'), close = t('pane.close');
  return `<span class="st"><b>${esc(`${w.id} ${x?.title ?? w.title}`)}</b><small>${esc(sub)}</small></span><div class="seg seg-lg ws-tabs" role="tablist">${tabs}</div><div class="osplit">${openSplitHtml(w)}</div><button type="button" class="btn btn-icon btn-lg" data-action="export-menu" data-id="${esc(w.id)}" aria-haspopup="menu" aria-expanded="false" aria-label="${esc(more)}" data-tip="${esc(more)}">${svg('s-more')}</button><button type="button" class="btn btn-icon pclose" data-action="pane-close" data-v="pair" aria-label="${esc(close)}" data-tip="${esc(close)}">${svg('s-x')}</button>`;
}

/**
 * Draws the two panes, or one: the view's layout, the selected pane's ring and close button, and the other pane's
 * header, body and composer (its draft, kept for it in app.ts). `force` draws its body again.
 */
export function renderPair(force = false) {
  const main = $('#wk-session').parentElement!;
  const on = panesShown();
  main.classList.toggle('panes', on);
  $('#wk-pair').hidden = !on;
  $('#ws-close').hidden = !on;
  if (!on || !ui.pair) { drawn = { head: '', log: '', body: '' }; return; }
  main.classList.toggle('pair-left', ui.pair.left);
  const w = worker(ui.pair.id)!;
  if (!w.repo && ui.pair.tab === 'changes') ui.pair = { ...ui.pair, tab: 'chat' };
  const tab = ui.pair.tab;
  const head = headHtml(w, tab);
  if (head !== drawn.head) { $('#wp-head').innerHTML = head; drawn.head = head; }
  for (const v of ['chat', 'changes', 'summary'] as const) bodyOf('wp', v).hidden = v !== tab;
  const body = bodyOf('wp', tab);
  const at = `${w.id}:${tab}`;
  if (tab === 'chat') {
    const log = ui.logs.get(w.id);
    if (!log) void loadPairLog(w.id);
    const key = `${lang()}:${at}:${ui.logFrom.get(w.id) ?? 0}:${log?.length ?? -1}:${w.status}:${w.statusText}`;
    if (log && (force || key !== drawn.log)) {
      const follow = drawn.body !== at || body.scrollHeight - body.scrollTop - body.clientHeight < 80;
      setThread(body, logHtml(w, log), follow, false);
      noTabStops(body);
      drawn.log = key;
    }
  } else if (force || drawn.body !== at) {
    if (tab === 'changes') renderDiff(w, body); else renderSummary(w, body);
    noTabStops(body);
  }
  drawn.body = at;
  const d = draftOf(w.id);
  const input = $('#wp-input');
  if (input.textContent !== (d?.text ?? '')) input.textContent = d?.text ?? '';
  input.dataset.ph = t('pane.to', { id: w.id });
}

/** A click in the other pane selects it; its header's own buttons (open, ⋯, close) do their thing without that. */
export function bindPanes() {
  $('#wk-pair').addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (el && $('#wp-head').contains(el) && el.dataset.action !== 'pane-tab') return;
    e.preventDefault();
    e.stopPropagation();
    selectOther(!!(e.target as HTMLElement).closest('#wp-form'), el?.dataset.action === 'pane-tab' ? (el.dataset.v as WTab) : null);
  }, true);
  // The view goes to one pane below the width two need, and back to two above it.
  let wide = panesFit(innerWidth);
  addEventListener('resize', () => {
    if (panesFit(innerWidth) === wide) return;
    wide = !wide;
    if (ui.view === 'worker' && ui.pair) { renderSession(true); renderPair(true); }
  });
}
